export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    const body = buffer.toString();
    
    const boundary = req.headers['content-type'].split('boundary=')[1];
    const parts = body.split('--' + boundary);
    
    let instructions = '';
    let fileBase64 = '';
    let fileName = '';
    let mimeType = 'application/pdf';

    for (const part of parts) {
      if (part.includes('name="instructions"')) {
        instructions = part.split('\r\n\r\n')[1]?.replace(/\r\n--$/, '').trim();
      }
      if (part.includes('name="files"')) {
        const headerEnd = part.indexOf('\r\n\r\n');
        const header = part.substring(0, headerEnd);
        const fnMatch = header.match(/filename="([^"]+)"/);
        if (fnMatch) fileName = fnMatch[1];
        const mtMatch = header.match(/Content-Type: ([^\r\n]+)/);
        if (mtMatch) mimeType = mtMatch[1].trim();
        const content = part.substring(headerEnd + 4);
        fileBase64 = Buffer.from(content, 'binary').toString('base64');
      }
    }

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
                data: fileBase64
              }
            },
            {
              type: 'text',
              text: `Extract these fields from this invoice. Return ONLY a valid JSON object with no extra text: ${instructions}`
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
      extracted = { raw: text };
    }

    return res.status(200).json({
      results: [{
        filename: fileName,
        data: extracted,
        confidence: 97
      }]
    });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
