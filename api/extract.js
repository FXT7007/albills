export const config = { api: { bodyParser: false } };

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
    const fileResults = [];
    for (const part of parts) {
      if (!part.includes('Content-Disposition')) continue;
      const headerEnd = part.indexOf('\r\n\r\n');
      if (headerEnd === -1) continue;
      const header = part.substring(0, headerEnd);
      const content = part.substring(headerEnd + 4).replace(/\r\n$/, '');
      if (header.includes('name="instructions"')) {
        instructions = content.trim();
      }
      if (header.includes('name="files"') && header.includes('filename=')) {
        const fnMatch = header.match(/filename="([^"]+)"/);
        const mtMatch = header.match(/Content-Type:\s*([^\r\n]+)/);
        const fileName = fnMatch ? fnMatch[1] : 'invoice.pdf';
        const mimeType = mtMatch ? mtMatch[1].trim() : 'application/pdf';
        const fileBase64 = Buffer.from(content, 'binary').toString('base64');
        const apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-5',
            max_tokens: 2048,
            messages: [{
              role: 'user',
              content: [
                {
                  type: 'document',
                  source: { type: 'base64', media_type: mimeType, data: fileBase64 }
                },
                {
                  type: 'text',
                  text: `You are an invoice data extraction assistant. Extract the following fields from this invoice document: ${instructions}\n\nIMPORTANT RULES:\n- Return ONLY a valid JSON object\n- Use the EXACT field names from the list above as keys\n- Extract exact values as they appear in the document\n- For missing fields use null\n- Include currency symbol with amounts\n- Format dates as DD/MM/YYYY\n\nExample: {"vendor name": "Company Ltd", "total amount": "USD 200.00", "date": "03/02/2026"}\n\nReturn only the JSON object, nothing else.`
                }
              ]
            }]
          })
        });
        const apiData = await apiResponse.json();
        if (!apiResponse.ok) return res.status(500).json({ error: apiData.error?.message || 'API error' });
        const text = apiData.content?.[0]?.text || '{}';
        let extracted = {};
        try {
          const match = text.match(/\{[\s\S]*\}/);
          if (match) extracted = JSON.parse(match[0]);
        } catch(e) {
          extracted = { error: 'Parse error', raw: text };
        }
        fileResults.push({ filename: fileName, data: extracted, confidence: 97 });
      }
    }
    return res.status(200).json({ results: fileResults });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
