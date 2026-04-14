export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const params = new URLSearchParams(body);
    const email = params.get('email');
    const refunded = params.get('refunded');
    if (refunded === 'true') return res.status(200).json({ message: 'Refund ignored' });
    if (!email) return res.status(400).json({ error: 'No email' });
    const creditsToAdd = 10;
    const SUPABASE_URL = 'https://bynkbsuphhyxsnnbftoa.supabase.co';
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
    const headers = { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };
    const authRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(email)}`, { headers });
    const authData = await authRes.json();
    const userId = authData?.users?.[0]?.id;
    if (!userId) return res.status(200).json({ message: 'User not found — credits pending' });
    const profileRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=credits`, { headers });
    const profileData = await profileRes.json();
    const newCredits = (profileData?.[0]?.credits || 0) + creditsToAdd;
    await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`, { method: 'PATCH', headers: { ...headers, 'Prefer': 'return=minimal' }, body: JSON.stringify({ credits: newCredits }) });
    return res.status(200).json({ success: true, email, credits_added: creditsToAdd, new_total: newCredits });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
