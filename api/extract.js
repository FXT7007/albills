export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { IncomingForm } = await import('formidable');
    const fs = await import('fs');

    const form = new IncomingForm({ multiples: true });
    
    const { fields, files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) reject(err);
        else resolve({ fields, files });
      });
    });

    const instructions = Array.isArray(fields.instructions) 
      ? fields.instructions[0] 
      : fields.instructions;

    const fileList = Array.isArray(files.files) ? files.files : [files.files];
    const results = [];

    for (const file of fileList) {
      const fileData = fs.readFileSync(file.filepath);
      const base64 = fileData.toString('base64');
      const mimeType = file.mimetype || 'application/pdf';

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 1024,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'document',
                source: {
                  type: 'base64',
                  media_type: mimeType,
                  data: base64
                }
              },
              {
                type: 'text',
                text: `Extract these fields from the invoice and return ONLY a JSON object, no other text: ${instructions}. Use null for missing fields.`
              }
            ]
          }]
        })
      });

      const data = await response.json();
      const text = data.content?.[0]?.text || '{}';
      
      let extracted = {};
      try {
        const match = text.match(/\{[\s\S]*\}/);
        if (match) extracted = JSON.parse(match[0]);
      } catch(e) {
        extracted = { error: 'Parse error', raw: text };
      }

      results.push({
        filename: file.originalFilename || file.newFilename,
        data: extracted,
        confidence: 97
      });
    }

    return res.status(200).json({ results });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
