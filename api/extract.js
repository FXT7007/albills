export const config = { api: { bodyParser: false } };

const SUPABASE_URL = 'https://bynkbsuphhyxsnnbftoa.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function supabase(path, method, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=representation' : ''
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return res.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);
    const contentType = req.headers['content-type'] || '';
    const boundary = contentType.split('boundary=')[1];
    if (!boundary) return res.status(400).json({ error: 'No boundary' });

    const bodyStr = buffer.toString('latin1');
    const parts = bodyStr.split('--' + boundary);

    let instructions = '';
    let userId = null;
    let fingerprint = null;
    let splitLineItems = false;
    let templateColumns = [];
    const fileResults = [];

    for (const part of parts) {
      if (!part.includes('Content-Disposition')) continue;
      const headerEnd = part.indexOf('\r\n\r\n');
      if (headerEnd === -1) continue;
      const header = part.substring(0, headerEnd);
      const content = part.substring(headerEnd + 4).replace(/\r\n$/, '');

      if (header.includes('name="instructions"')) instructions = content.trim();
      if (header.includes('name="userId"')) userId = content.trim();
      if (header.includes('name="fingerprint"')) fingerprint = content.trim();
      if (header.includes('name="splitLineItems"')) splitLineItems = content.trim() === 'true';
      if (header.includes('name="templateColumns"')) {
        try { templateColumns = JSON.parse(content.trim()); } catch(e) {}
      }

      if (header.includes('name="files"') && header.includes('filename=')) {
        const fnMatch = header.match(/filename="([^"]+)"/);
        const mtMatch = header.match(/Content-Type:\s*([^\r\n]+)/);
        const fileName = fnMatch ? fnMatch[1] : 'invoice.pdf';
        const mimeType = mtMatch ? mtMatch[1].trim() : 'application/pdf';
        const fileBase64 = Buffer.from(content, 'binary').toString('base64');

        // Build extraction prompt
        const fieldsToExtract = templateColumns.length > 0
          ? templateColumns.join(', ')
          : instructions;

        const lineItemInstruction = splitLineItems
          ? `For line items: create a SEPARATE JSON object for each line item. Each line item object must include all header fields PLUS these line item fields: "line_description", "line_quantity", "line_unit_price", "line_tax_rate", "line_tax_amount", "line_total". Return an ARRAY of objects, one per line item, each repeating the invoice header data.`
          : `Include all line items combined in a single "line_items" field as a text summary.`;

        const prompt = `You are an expert invoice data extraction assistant. Extract data from this invoice.

FIELDS TO EXTRACT: ${fieldsToExtract}

LINE ITEM RULE: ${lineItemInstruction}

IMPORTANT RULES:
- Return ONLY valid JSON (object if no split, array if split line items)
- Use EXACT field names provided as keys
- Extract exact values as they appear
- For missing fields use null
- Include currency symbol with amounts
- Format dates as DD/MM/YYYY
- For amounts always include currency code

Return only the JSON, nothing else.`;

        const apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-5',
            max_tokens: 4096,
            messages: [{
              role: 'user',
              content: [
                { type: 'document', source: { type: 'base64', media_type: mimeType, data: fileBase64 } },
                { type: 'text', text: prompt }
              ]
            }]
          })
        });

        const apiData = await apiResponse.json();
        if (!apiResponse.ok) return res.status(500).json({ error: apiData.error?.message || 'API error' });

        const text = apiData.content?.[0]?.text || '{}';
        let extracted = {};
        let lineRows = [];

        try {
          const match = text.match(/[\[\{][\s\S]*[\]\}]/);
          if (match) {
            const parsed = JSON.parse(match[0]);
            if (Array.isArray(parsed)) {
              lineRows = parsed;
              extracted = parsed[0] || {};
            } else {
              extracted = parsed;
            }
          }
        } catch(e) {
          extracted = { error: 'Parse error', raw: text };
        }

        fileResults.push({
          filename: fileName,
          data: extracted,
          lineRows: splitLineItems ? lineRows : null,
          confidence: 97
        });
      }
    }

    // Track usage in Supabase
    if (userId && userId !== 'anonymous') {
      // Logged in user — deduct credit
      await supabase(
        `invoice_usage`,
        'POST',
        {
          user_id: userId,
          invoice_count: fileResults.length,
          created_at: new Date().toISOString()
        }
      );
    } else if (fingerprint) {
      // Anonymous user — track by fingerprint
      const existing = await supabase(
        `anonymous_usage?fingerprint=eq.${fingerprint}&select=count`,
        'GET'
      );
      const used = Array.isArray(existing) && existing[0] ? existing[0].count : 0;

      if (used + fileResults.length > 3) {
        return res.status(403).json({
          error: 'FREE_LIMIT_REACHED',
          used: used,
          limit: 3
        });
      }

      await supabase('anonymous_usage', 'POST', {
        fingerprint,
        count: (used || 0) + fileResults.length,
        last_used: new Date().toISOString()
      });
    }

    return res.status(200).json({ results: fileResults });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
