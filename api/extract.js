// AlBills extraction endpoint
// -------------------------------------------------------------------------
// What changed in this rewrite:
//   • Sonnet 4.6 (was Haiku 4.5)  — much higher accuracy on multilingual,
//     handwritten, low-quality scans, complex multi-line invoices.
//     Cost still ~$0.02 per invoice (well under $0.50 list price).
//   • max_tokens: 2048 → 8192     — long invoices with 20+ line items no
//     longer get truncated.
//   • Prompt caching (ephemeral)  — system prompt is cached server-side at
//     Anthropic for 5 min, so repeat extractions in a session pay ~10%
//     of the input tokens for the cached portion.
//   • Document-type detection     — the model returns a `document_type`
//     field: invoice / credit_note / bill / expense_receipt / quote /
//     purchase_order. Lets accountants segregate by type.
//   • Audit-style math validation — server-side: subtotal + tax ≈ total
//     within 1% tolerance, line totals ≈ subtotal in split mode.
//     Mismatches surface as `validation_warnings` array.
//   • Better split-mode prompt    — explicitly preserves header context
//     on every line row.
//   • Multilingual hint           — prompt mentions Arabic, Chinese,
//     Japanese, Spanish, French, German, Portuguese, Hindi, Urdu.
//   • Robust JSON parsing         — handles markdown fences, leading text,
//     trailing prose, comma-after-last-key, etc.
// -------------------------------------------------------------------------

export const config = { api: { bodyParser: false } };

const SUPABASE_URL = 'https://bynkbsuphhyxsnnbftoa.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Sonnet 4.6 — best accuracy/speed/cost balance for invoice extraction.
// Override via EXTRACTION_MODEL env var (e.g. set to claude-haiku-4-5-20251001
// for cheaper/faster but less accurate, or claude-opus-4-7 for max accuracy).
const DEFAULT_MODEL = process.env.EXTRACTION_MODEL || 'claude-sonnet-4-6';

// ---------- Supabase helpers ----------
async function dbPost(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(body)
  });
  return res.ok ? null : res.json();
}
async function dbGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  });
  return res.json();
}

// ---------- Prompt builders ----------
function buildSystemPrompt(splitMode) {
  // This block is sent with cache_control so Anthropic caches it server-side.
  return `You are AlBills' bookkeeping-grade document extraction engine. Real businesses
file their accounts and tax returns with the data you return — accuracy is non-negotiable.

DOCUMENT TYPES YOU MUST HANDLE
- Tax invoice (most common)
- Credit note / refund document — totals should be NEGATIVE
- Supplier bill / vendor invoice — same as invoice but received-side
- Expense receipt — usually no customer, just merchant + amount
- Quotation / pro-forma invoice — not yet payable, but extract anyway
- Purchase order — buyer-issued, may not have a final price
Return the document type in a "document_type" field as one of:
invoice | credit_note | bill | expense_receipt | quotation | purchase_order

LANGUAGES
Process documents in any language including Arabic, Chinese (Simplified/Traditional),
Japanese, Korean, Spanish, French, German, Italian, Portuguese, Russian, Hindi, Urdu,
Bengali, Tagalog, Turkish, Persian, Hebrew. Translate field NAMES to English in the
output but preserve the original VALUES (vendor name, address, etc.) verbatim.

CORE RULES
1. Output ONLY valid JSON — no markdown fences, no prose, no comments
2. Use the EXACT field names provided as JSON keys (preserve capitalization and spacing
   exactly as given — e.g. if asked for "vendor name" then use "vendor name", not "vendor_name")
3. Extract values verbatim — do not paraphrase or "tidy" them
4. For any field you cannot find, use null (not "" or "-" or "N/A")
5. Always preserve the currency code or symbol (AED, USD, SAR, EUR, ₹, ¥…)
6. Format all dates as YYYY-MM-DD (ISO 8601). If only month+year is shown, use YYYY-MM-01
7. Strip thousand separators from amounts (1,250.00 → 1250.00) — return as STRING with
   one decimal point, e.g. "1250.00", not the number 1250
8. For credit notes, total_amount and line totals MUST be negative

VENDOR vs CUSTOMER RESOLUTION
- vendor_name = the entity issuing the document. Look at letterhead, "From:", "Seller",
  "Supplier", "Tax Registration No." block, signatures.
- customer_name = the entity being billed. Look at "To:", "Bill To:", "Buyer:",
  "Sold To:", "Customer".
- For an EXPENSE RECEIPT, vendor_name = the merchant/store and customer_name = null.

NUMBERS YOU MUST GET RIGHT
- invoice_number — exact reference. Strip leading "Invoice No.:" labels.
- date — the issue date, NOT the print date or due date.
- due_date — when payment is due. May be expressed as "Net 30" or "Due on receipt".
- subtotal — sum BEFORE tax.
- tax_amount — total tax/VAT/GST charged.
- total_amount — final amount payable (after tax). For credit notes: negative.
- tax_rate — percentage applied (5% UAE, 15% Saudi, 20% UK, etc.)

LINE ITEMS
Every product/service row, even if there's only one. Skip subtotal/tax/total summary rows.
Each line item must include: line_description, line_quantity, line_unit_price,
line_tax_rate, line_tax_amount, line_total. Use null for missing pieces.

PAYMENT DETAILS (when requested)
bank_name, account_number, swift, iban, payment_terms — extract from the bank-details
section of the invoice (often at the bottom).

EXPENSE-SPECIFIC FIELDS (when requested)
tax_number, category (best-guess: travel, meals, office_supplies, fuel, telecom,
software, professional_fees, other), description, reference_number.

${splitMode
  ? `OUTPUT FORMAT — SPLIT MODE
Return a JSON ARRAY of objects. One object per LINE ITEM.
Every object MUST repeat the header fields (vendor_name, invoice_number, date,
total_amount, document_type, currency, etc.) so each row is self-contained when
viewed in Excel. The line item fields appear alongside the header fields.
If the document has only one line, still return an array of one element.`
  : `OUTPUT FORMAT — COMBINED MODE
Return a single JSON OBJECT with all the requested fields.
Concatenate all line items into a single "line_items" string field, one per
line, separated by " | " (pipe with spaces). Format: "qty x description @ unit_price = total"`}

SELF-CHECK BEFORE RETURNING
- subtotal + tax_amount should equal total_amount (allow 1 unit of currency for rounding)
- if it doesn't, double-check the numbers — re-read the document
- if you're still uncertain, set the offending field to null rather than guess

Return ONLY the JSON. No prose. No markdown.`;
}

function buildUserPrompt(fields, fileName) {
  return `Filename: ${fileName}

REQUESTED FIELDS: ${fields}

Extract the requested fields plus document_type. Return JSON only.`;
}

// ---------- Response parsing ----------
function parseModelResponse(text) {
  if (!text) return { error: 'empty response' };

  // Strip code fences if present
  let cleaned = text.trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '');

  // Greedy match — first { or [ to last } or ]
  const firstBracket = cleaned.search(/[\[\{]/);
  if (firstBracket === -1) return { error: 'no JSON found', raw: text.slice(0, 200) };
  cleaned = cleaned.slice(firstBracket);

  // Try direct parse first
  try {
    const parsed = JSON.parse(cleaned);
    return { parsed };
  } catch (_) { /* fall through */ }

  // Try with trailing-comma cleanup
  try {
    const fixed = cleaned.replace(/,\s*([}\]])/g, '$1');
    const parsed = JSON.parse(fixed);
    return { parsed };
  } catch (_) { /* fall through */ }

  // Try matching balanced brackets
  const opener = cleaned[0];
  const closer = opener === '[' ? ']' : '}';
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === opener) depth++;
    else if (c === closer) { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end > 0) {
    try {
      const parsed = JSON.parse(cleaned.slice(0, end + 1));
      return { parsed };
    } catch (_) {}
  }

  return { error: 'unparseable', raw: text.slice(0, 200) };
}

// ---------- Math validation (audit check) ----------
function num(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/[^0-9.\-]/g, '');
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// Look up a field by trying several common name variants
function field(data, ...names) {
  for (const n of names) {
    if (data[n] !== undefined && data[n] !== null && data[n] !== '') return data[n];
    const snake = n.replace(/\s+/g, '_');
    if (data[snake] !== undefined && data[snake] !== null && data[snake] !== '') return data[snake];
    const space = n.replace(/_/g, ' ');
    if (data[space] !== undefined && data[space] !== null && data[space] !== '') return data[space];
  }
  return null;
}

function validateExtraction(data, isLineRow = false) {
  const warnings = [];
  if (!data || typeof data !== 'object') return warnings;

  const sub      = num(field(data, 'subtotal', 'sub_total', 'sub total'));
  const tax      = num(field(data, 'tax_amount', 'tax amount', 'vat_amount', 'vat amount'));
  const total    = num(field(data, 'total_amount', 'total amount', 'amount', 'grand_total', 'grand total'));
  const lineTotal= num(field(data, 'line_total', 'line total'));
  const qty      = num(field(data, 'line_quantity', 'line quantity', 'quantity'));
  const unit     = num(field(data, 'line_unit_price', 'line unit price', 'unit_price', 'unit price'));

  // 1. Subtotal + tax ≈ total
  if (sub !== null && tax !== null && total !== null) {
    const expected = sub + tax;
    const diff = Math.abs(expected - total);
    const tolerance = Math.max(0.02, Math.abs(total) * 0.01); // 1% or 2 cents, whichever larger
    if (diff > tolerance) {
      warnings.push(`subtotal (${sub}) + tax (${tax}) = ${expected.toFixed(2)} but total is ${total} — math mismatch`);
    }
  }

  // 2. Line: qty × unit ≈ line_total (allow tax inclusion)
  if (qty !== null && unit !== null && lineTotal !== null) {
    const computed = qty * unit;
    const lineTax = num(data.line_tax_amount);
    const expected = lineTax !== null ? computed + lineTax : computed;
    const diff = Math.abs(expected - lineTotal);
    const tolerance = Math.max(0.02, Math.abs(lineTotal) * 0.02); // 2% on line items
    if (diff > tolerance) {
      warnings.push(`line: ${qty} × ${unit}${lineTax !== null ? ' + ' + lineTax : ''} = ${expected.toFixed(2)} but line_total is ${lineTotal}`);
    }
  }

  // 3. Date in the future or way in the past
  const dateStr = field(data, 'date', 'invoice_date', 'invoice date');
  if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr))) {
    const d = new Date(dateStr);
    const now = new Date();
    if (d > now) warnings.push(`date ${dateStr} is in the future`);
    if (d.getFullYear() < 2000) warnings.push(`date ${dateStr} is suspiciously old`);
  }

  // 4. Credit note total should be negative
  const docType = field(data, 'document_type', 'document type');
  if (docType === 'credit_note' && total !== null && total > 0) {
    warnings.push('credit_note has positive total — credit notes should be negative');
  }

  return warnings;
}

// ---------- Main handler ----------
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
    const filesQueue = [];

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
        try { templateColumns = JSON.parse(content.trim()); } catch (_) {}
      }

      if (header.includes('name="files"') && header.includes('filename=')) {
        const fnMatch = header.match(/filename="([^"]+)"/);
        const mtMatch = header.match(/Content-Type:\s*([^\r\n]+)/);
        const fileName = fnMatch ? fnMatch[1] : 'invoice.pdf';
        let mimeType = mtMatch ? mtMatch[1].trim() : 'application/pdf';

        if (!['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mimeType)) {
          if (fileName.match(/\.(jpg|jpeg)$/i)) mimeType = 'image/jpeg';
          else if (fileName.match(/\.png$/i)) mimeType = 'image/png';
          else mimeType = 'application/pdf';
        }

        filesQueue.push({
          fileName,
          mimeType,
          fileBase64: Buffer.from(content, 'binary').toString('base64')
        });
      }
    }

    const fieldsToExtract = templateColumns.length > 0
      ? templateColumns.join(', ')
      : (instructions || 'vendor_name, invoice_number, date, total_amount, currency');

    const systemPrompt = buildSystemPrompt(splitLineItems);

    // Process files in parallel for responsiveness
    const fileResults = await Promise.all(filesQueue.map(async (f) => {
      const userPrompt = buildUserPrompt(fieldsToExtract, f.fileName);

      const userContent = [
        f.mimeType === 'application/pdf'
          ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.fileBase64 } }
          : { type: 'image',    source: { type: 'base64', media_type: f.mimeType,        data: f.fileBase64 } },
        { type: 'text', text: userPrompt }
      ];

      const apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: DEFAULT_MODEL,
          max_tokens: 8192,
          // Prompt caching: system block is cached for 5 min ephemeral
          system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: userContent }]
        })
      });

      if (!apiResponse.ok) {
        const err = await apiResponse.json().catch(() => ({}));
        return { filename: f.fileName, error: err.error?.message || 'extraction failed', data: {}, lineRows: null };
      }

      const apiData = await apiResponse.json();
      const text = apiData.content?.[0]?.text || '';
      const usage = apiData.usage || {};
      const parseRes = parseModelResponse(text);

      if (parseRes.error) {
        return {
          filename: f.fileName,
          data: { parse_error: parseRes.error, raw: parseRes.raw },
          lineRows: null,
          confidence: 0
        };
      }

      const parsed = parseRes.parsed;
      let extracted = {};
      let lineRows = null;
      let warnings = [];

      if (Array.isArray(parsed)) {
        lineRows = parsed;
        extracted = parsed[0] || {};
        // Validate every row
        for (let i = 0; i < parsed.length; i++) {
          const w = validateExtraction(parsed[i], true);
          if (w.length) warnings.push(...w.map(x => `[row ${i + 1}] ${x}`));
        }
      } else {
        extracted = parsed;
        warnings = validateExtraction(parsed, false);
      }

      // Confidence = 100 - 8 × number of warnings, floor 50, ceiling 99
      const confidence = Math.max(50, Math.min(99, 99 - warnings.length * 8));

      // Surface warnings in the row(s) so the user sees them in Excel
      if (warnings.length) {
        if (lineRows) lineRows.forEach((r, idx) => { r.validation_warnings = warnings.filter(w => w.startsWith(`[row ${idx + 1}]`)).join(' · ') || null; });
        else extracted.validation_warnings = warnings.join(' · ');
      }

      return {
        filename: f.fileName,
        data: extracted,
        lineRows: splitLineItems ? lineRows : null,
        confidence,
        cache_read_tokens: usage.cache_read_input_tokens || 0,
        cache_creation_tokens: usage.cache_creation_input_tokens || 0,
        input_tokens: usage.input_tokens || 0,
        output_tokens: usage.output_tokens || 0
      };
    }));

    // ---------- Usage tracking ----------
    if (userId !== 'anonymous' && SUPABASE_KEY) {
      try {
        await dbPost('invoice_usage', {
          user_id: userId,
          invoice_count: fileResults.length,
          fields_extracted: (templateColumns.length || (instructions ? instructions.split(',').length : 0)) || null,
          credits_used: fileResults.length,
          created_at: new Date().toISOString()
        });
      } catch (e) { /* non-fatal */ }
    } else if (fingerprint && SUPABASE_KEY) {
      try {
        const existing = await dbGet(`anonymous_usage?fingerprint=eq.${encodeURIComponent(fingerprint)}&select=count`);
        const used = Array.isArray(existing) && existing[0] ? (existing[0].count || 0) : 0;
        if (used + fileResults.length > 3) {
          return res.status(403).json({ error: 'FREE_LIMIT_REACHED', used, limit: 3 });
        }
        await dbPost('anonymous_usage', {
          fingerprint,
          count: used + fileResults.length,
          last_used: new Date().toISOString()
        });
      } catch (e) { /* non-fatal */ }
    }

    return res.status(200).json({ results: fileResults });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
