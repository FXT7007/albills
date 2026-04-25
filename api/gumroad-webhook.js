// Gumroad Ping webhook — hardened.
//
// What this does:
//   1. Authenticates the request with a shared secret (?secret=… or x-gumroad-secret header).
//      Anyone who knows the URL alone CANNOT credit accounts.
//   2. Idempotent: stores sale_id and refuses to credit the same sale twice (in case Gumroad retries).
//   3. Resolves credits-per-sale from product permalink (single source of truth).
//   4. If the buyer's Gumroad email doesn't match an AlBills account, the credits go into a
//      pending_credits queue and get redeemed automatically the first time that email signs in.
//   5. Refunds are acknowledged (no-op for now — extend to revoke unused credits if needed).
//
// Required env vars (Vercel → Settings → Environment Variables):
//   SUPABASE_SERVICE_KEY    (existing) - service-role key, bypasses RLS
//   GUMROAD_WEBHOOK_SECRET  (new)      - any long random string. Append the SAME string to the
//                                        Gumroad Ping URL as ?secret=<value> so it's sent every time.
//
// Required Supabase tables (run scripts/gumroad-tables.sql once):
//   gumroad_sales      - idempotency log (sale_id PK)
//   pending_credits    - queue for unknown-email purchases

const SUPABASE_URL = 'https://bynkbsuphhyxsnnbftoa.supabase.co';

// Map Gumroad permalink -> credits to add. Keep in sync with Gumroad products.
const CREDITS_BY_PERMALINK = {
  'albills-pro': 10
};
const DEFAULT_CREDITS = 10;

function buildHeaders(serviceKey) {
  return {
    'apikey': serviceKey,
    'Authorization': `Bearer ${serviceKey}`,
    'Content-Type': 'application/json'
  };
}

async function dbGet(path, headers) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers });
  if (!r.ok) return null;
  return r.json();
}

async function dbInsert(path, body, headers) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: { ...headers, 'Prefer': 'return=minimal' },
    body: JSON.stringify(body)
  });
}

async function dbPatch(path, body, headers) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: { ...headers, 'Prefer': 'return=minimal' },
    body: JSON.stringify(body)
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const SECRET = process.env.GUMROAD_WEBHOOK_SECRET;
    const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
    if (!SUPA_KEY) {
      return res.status(500).json({ error: 'Server not configured (missing SUPABASE_SERVICE_KEY)' });
    }

    // ---------- Read body ----------
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const params = new URLSearchParams(body);

    // ---------- 1. Authenticate ----------
    // Accept the secret as body field, query string or header.
    if (SECRET) {
      const provided =
        params.get('secret') ||
        (req.headers['x-gumroad-secret'] || '') ||
        ((req.url || '').match(/[?&]secret=([^&]+)/) || [])[1] ||
        '';
      if (provided !== SECRET) {
        return res.status(401).json({ error: 'Invalid or missing secret' });
      }
    }
    // If GUMROAD_WEBHOOK_SECRET isn't set, the endpoint is open. Set it before going live.

    const email = (params.get('email') || '').trim().toLowerCase();
    const saleId = params.get('sale_id') || params.get('sale_timestamp') || '';
    const refunded = params.get('refunded');
    const permalink = params.get('product_permalink') || params.get('permalink') || '';
    const credits = CREDITS_BY_PERMALINK[permalink] ?? DEFAULT_CREDITS;

    if (refunded === 'true') {
      return res.status(200).json({ message: 'Refund acknowledged (no-op)' });
    }
    if (!email) return res.status(400).json({ error: 'No email' });

    const headers = buildHeaders(SUPA_KEY);

    // ---------- 2. Idempotency check (skip if gumroad_sales table doesn't exist yet) ----------
    if (saleId) {
      const existing = await dbGet(
        `gumroad_sales?sale_id=eq.${encodeURIComponent(saleId)}&select=sale_id`,
        headers
      );
      if (Array.isArray(existing) && existing.length > 0) {
        return res.status(200).json({ message: 'Duplicate sale, skipped', sale_id: saleId });
      }
    }

    // ---------- 3. Resolve user by email ----------
    const authRes = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(email)}`,
      { headers }
    );
    const authData = await authRes.json();
    const userId = authData?.users?.[0]?.id;

    if (!userId) {
      // ---------- 4a. Unknown email -> queue ----------
      await dbInsert('pending_credits', {
        email,
        credits,
        sale_id: saleId || null,
        permalink: permalink || null
      }, headers);
      if (saleId) {
        await dbInsert('gumroad_sales', {
          sale_id: saleId, email, user_id: null, credits_added: credits, permalink
        }, headers);
      }
      return res.status(200).json({
        message: 'Buyer email not yet registered — credits queued, will apply on signup',
        email, credits
      });
    }

    // ---------- 4b. Known user -> credit immediately ----------
    const profileRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=credits`,
      { headers }
    );
    const profileData = await profileRes.json();
    const oldCredits = profileData?.[0]?.credits ?? 0;
    const newCredits = oldCredits + credits;
    await dbPatch(`profiles?id=eq.${userId}`, { credits: newCredits }, headers);

    if (saleId) {
      await dbInsert('gumroad_sales', {
        sale_id: saleId, email, user_id: userId, credits_added: credits, permalink
      }, headers);
    }

    return res.status(200).json({
      success: true,
      email,
      credits_added: credits,
      new_total: newCredits,
      sale_id: saleId || null
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
