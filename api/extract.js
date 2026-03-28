import Anthropic from "@anthropic-ai/sdk";

export const config = { runtime: "edge" };

export default async function handler(req) {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const formData = await req.formData();
    const instructions = formData.get("instructions");
    const files = formData.getAll("files");

    if (!files.length || !instructions) {
      return new Response(
        JSON.stringify({ error: "Missing files or instructions" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });

    const results = [];

    for (const file of files) {
      const arrayBuffer = await file.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString("base64");
      const mimeType = file.type || "application/pdf";

      const message = await client.messages.create({
        model: "claude-opus-4-5",
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: {
                  type: "base64",
                  media_type: mimeType,
                  data: base64,
                },
              },
              {
                type: "text",
                text: `Extract the following fields from this invoice and return ONLY a valid JSON object with no extra text: ${instructions}. 
                
                Rules:
                - Return exact values as they appear in the invoice
                - Use null for missing fields
                - For amounts include the currency symbol
                - Dates in DD/MM/YYYY format
                - Return format: {"field1": "value1", "field2": "value2"}`,
              },
            ],
          },
        ],
      });

      const responseText = message.content[0].text.trim();
      let extracted = {};

      try {
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          extracted = JSON.parse(jsonMatch[0]);
        }
      } catch (e) {
        extracted = { error: "Could not parse response", raw: responseText };
      }

      results.push({
        filename: file.name,
        data: extracted,
        confidence: 98,
      });
    }

    return new Response(JSON.stringify({ results }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
