// One-shot cleanup endpoint to remove synthetic test data from gumroad_sales
// and pending_credits. Guarded by GUMROAD_WEBHOOK_SECRET so only Claude/the
// admin can hit it. Will be deleted after use.

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const SECRET = process.env.GUMROAD_WEBHOOK_SECRET;
  const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
  const SUPA_URL = 'https://bynkbsuphhyxsnnbftoa.supabase.co';
  const provided = (req.query && req.query.secret) || '';
  if (!SECRET || provided.trim() !== String(SECRET).trim()) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const headers = {
    'apikey': SUPA_KEY,
    'Authorization': `Bearer ${SUPA_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };

  // Match the synthetic test domains used during the webhook E2E
  const filters = [
    "email=ilike.%25%40nowhere%25",       // %@nowhere%
    "email=ilike.%25%40example.com",      // %@example.com
    "email=ilike.diag%40example.com",
    "email=ilike.%25fresh-probe%25",
    "email=ilike.%25test-pending%25",
    "email=ilike.%25test-dup%25",
    "email=ilike.%25body-test%25",
    "email=ilike.%25header-test%25",
    "email=ilike.%25manual-probe%25",
    "email=ilike.%25ghost%25"
  ];

  const deleted = { gumroad_sales: 0, pending_credits: 0 };
  for (const f of filters) {
    for (const table of ['gumroad_sales', 'pending_credits']) {
      const r = await fetch(`${SUPA_URL}/rest/v1/${table}?${f}`, { method: 'DELETE', headers });
      if (r.ok) {
        const rows = await r.json();
        deleted[table] += Array.isArray(rows) ? rows.length : 0;
      }
    }
  }

  // Sanity counts after cleanup
  const counts = {};
  for (const table of ['gumroad_sales', 'pending_credits']) {
    const r = await fetch(`${SUPA_URL}/rest/v1/${table}?select=count`, {
      headers: { ...headers, 'Prefer': 'count=exact' }
    });
    counts[table] = r.headers.get('content-range') || 'unknown';
  }

  return res.status(200).json({ deleted, remaining_rows: counts });
}
