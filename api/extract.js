export const config = { api: { bodyParser: false } };

const SUPABASE_URL = 'https://bynkbsuphhyxsnnbftoa.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function dbPost(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(body)
  });
  return res.json();
}

async function dbGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`
    }
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
    let userId = 'anonymous';
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
        let mimeType = mtMatch ? mtMatch[1].trim() : 'application/pdf';

        // Fix mime type — Anthropic only accepts these image types
        if (!['application/pdf','image/jpeg','image/png','image/gif','image/webp'].includes(mimeType)) {
          if (fileName.match(/\.(jpg|jpeg)$/i)) mimeType = 'image/jpeg';
          else if (fileName.match(/\.png$/i)) mimeType = 'image/png';
          else mimeType = 'application/pdf';
        }

        const fileBase64 = Buffer.from(content, 'binary').toString('base64');
        const fieldsToExtract = templateColumns.length > 0 ? templateColumns.join(', ') : instructions;

        const lineRule = splitLineItems
          ? `CRITICAL: Return a JSON ARRAY where each element is one line item. Each element must include ALL invoice header fields (vendor name, invoice number, date, etc.) PLUS these line item fields: line_description, line_quantity, line_unit_price, line_tax_rate, line_tax_amount, line_total. One object per line item.`
          : `Include all line items as a text summary in a single "line_items" field.`;

        const prompt = `You are an expert invoice data extraction AI. Your job is to carefully read this invoice document and extract specific data fields.

FIELDS TO EXTRACT: ${fieldsToExtract}

RULES:
1. Return ONLY valid JSON — no explanation, no markdown, no backticks
2. Use the EXACT field names provided as JSON keys
3. Extract the EXACT values as they appear in the document
4. For any field you cannot find, use null (not empty string, not dash)
5. Always include the currency code or symbol with monetary amounts
6. Format all dates as DD/MM/YYYY
7. For vendor name: look for "From", "Seller", "Supplier", company letterhead at top
8. For customer name: look for "To", "Bill To", "Ship To", "Buyer"
9. For invoice number: look for "Invoice #", "Invoice No", "Inv #", reference numbers
10. For total amount: look for "Total", "Grand Total", "Amount Due", "Balance Due"
11. Look carefully at ALL text in the document including headers, footers, and stamps

${lineRule}

Example output format: {"vendor name": "ABC Company Ltd", "invoice number": "INV-2024-001", "date": "15/03/2024", "total amount": "USD 1,250.00", "currency": "USD"}

Return ONLY the JSON object or array. Nothing else.`;

        // Build content array — support both PDF and images
        const contentArr = [];
        
        if (mimeType === 'application/pdf') {
          contentArr.push({
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: fileBase64 }
          });
        } else {
          contentArr.push({
            type: 'image',
            source: { type: 'base64', media_type: mimeType, data: fileBase64 }
          });
        }
        
        contentArr.push({ type: 'text', text: prompt });

        const apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 2048,
            messages: [{ role: 'user', content: contentArr }]
          })
        });

        const apiData = await apiResponse.json();
        if (!apiResponse.ok) {
          console.error('API error:', apiData);
          return res.status(500).json({ error: apiData.error?.message || 'API error' });
        }

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
          extracted = { parse_error: text.substring(0, 200) };
        }

        fileResults.push({
          filename: fileName,
          data: extracted,
          lineRows: splitLineItems ? lineRows : null,
          confidence: 97
        });
      }
    }

    // Track usage
    if (userId !== 'anonymous' && SUPABASE_KEY) {
      try {
        await dbPost('invoice_usage', {
          user_id: userId,
          invoice_count: fileResults.length,
          fields_extracted: instructions.split(',').length,
          created_at: new Date().toISOString()
        });
      } catch(e) { console.error('DB log error:', e); }
    } else if (fingerprint && SUPABASE_KEY) {
      try {
        const existing = await dbGet(`anonymous_usage?fingerprint=eq.${fingerprint}&select=count`);
        const used = Array.isArray(existing) && existing[0] ? (existing[0].count || 0) : 0;
        if (used + fileResults.length > 3) {
          return res.status(403).json({ error: 'FREE_LIMIT_REACHED', used, limit: 3 });
        }
        await dbPost('anonymous_usage', {
          fingerprint,
          count: used + fileResults.length,
          last_used: new Date().toISOString()
        });
      } catch(e) { console.error('Anon track error:', e); }
    }

    return res.status(200).json({ results: fileResults });

  } catch (error) {
    console.error('Handler error:', error);
    return res.status(500).json({ error: error.message });
  }
}
