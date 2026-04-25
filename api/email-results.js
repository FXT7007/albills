// Email an Excel file of extraction results to the user.
//
// What this does:
//   - Accepts {email, filename, base64Excel} via POST
//   - If RESEND_API_KEY env var is set, sends a real email via Resend with
//     the Excel as an attachment
//   - If not set, returns a graceful fallback so the client knows to
//     handle delivery itself (download the file in the browser)
//
// Setup (free):
//   1. Sign up at https://resend.com (free 100 emails/day, no card)
//   2. Add a domain (or use the free 'onboarding@resend.dev' for testing)
//   3. Vercel -> Settings -> Environment Variables -> add:
//        RESEND_API_KEY     = re_xxx... (from resend.com/api-keys)
//        RESEND_FROM_EMAIL  = noreply@yourdomain.com (or onboarding@resend.dev)
//   4. Redeploy.

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  let body;
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = JSON.parse(Buffer.concat(chunks).toString());
  } catch (_) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const { email, filename = 'albills-extraction.xlsx', base64Excel, rowCount = 0 } = body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
  if (!base64Excel) return res.status(400).json({ error: 'No Excel content provided' });

  const RESEND_KEY = process.env.RESEND_API_KEY;
  const FROM = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';

  // No Resend configured -> tell client we couldn't send, so it can download instead
  if (!RESEND_KEY) {
    return res.status(200).json({
      success: false,
      reason: 'EMAIL_NOT_CONFIGURED',
      message: 'Email delivery is not enabled yet — your file is still ready to download.'
    });
  }

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: `AlBills <${FROM}>`,
        to: [email],
        subject: `Your AlBills extraction (${rowCount} row${rowCount === 1 ? '' : 's'})`,
        html: `
          <div style="font-family:system-ui,sans-serif;line-height:1.6;color:#1a1a1a">
            <h2 style="color:#5b8dee">Your invoices are extracted!</h2>
            <p>${rowCount} row${rowCount === 1 ? '' : 's'} have been processed and attached as an Excel file.</p>
            <p>Open the attached <b>${filename}</b> to see vendor names, invoice numbers, totals, and every line item.</p>
            <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
            <p style="font-size:13px;color:#777">
              Sent by <a href="https://www.albills.com" style="color:#5b8dee">AlBills</a> &middot;
              <a href="https://www.albills.com/extract" style="color:#5b8dee">Extract more</a> &middot;
              Documents are auto-deleted after extraction.
            </p>
          </div>
        `,
        attachments: [{ filename, content: base64Excel }]
      })
    });

    const data = await resp.json();
    if (!resp.ok) {
      return res.status(502).json({
        success: false,
        reason: 'RESEND_REJECTED',
        message: data.message || 'Email service rejected the request',
        details: data
      });
    }

    return res.status(200).json({ success: true, id: data.id });
  } catch (e) {
    return res.status(500).json({
      success: false,
      reason: 'SEND_FAILED',
      message: e.message || 'Network error while sending'
    });
  }
}
