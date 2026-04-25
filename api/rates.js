// Vercel Edge function — proxies live FX rates and gold spot price.
// Browser calls /api/rates and gets a unified JSON.
// Cached on Vercel's edge for 10 minutes (s-maxage), so we don't hammer upstreams.

export const config = { runtime: 'edge' };

const FX_URL = 'https://open.er-api.com/v6/latest/USD';
const GOLD_URL = 'https://stooq.com/q/l/?s=xauusd&f=sd2t2ohlcv&h&e=json';
const SILVER_URL = 'https://stooq.com/q/l/?s=xagusd&f=sd2t2ohlcv&h&e=json';

// Hardcoded fallbacks — used only if both upstreams fail.
const FX_FALLBACK = {
  USD: 1, AED: 3.6725, SAR: 3.75, EUR: 0.92, GBP: 0.79, INR: 83.5, PKR: 278,
  BDT: 110, EGP: 30.9, KWD: 0.307, QAR: 3.64, OMR: 0.385, JPY: 149.5,
  CNY: 7.24, SGD: 1.34, AUD: 1.53, CAD: 1.36, CHF: 0.88, TRY: 32.1,
  NGN: 1580, ZAR: 18.9, MYR: 4.72, PHP: 56.5
};
const GOLD_FALLBACK_USD_PER_TROY_OZ = 2385;

async function fetchJSON(url, timeoutMs = 4500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'AlBills/1.0' } });
    if (!r.ok) throw new Error(`upstream ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

async function getFx() {
  try {
    const data = await fetchJSON(FX_URL);
    if (data && data.rates && Object.keys(data.rates).length > 50) {
      return { rates: data.rates, base: data.base_code || 'USD', updated: data.time_last_update_unix || null, source: 'open.er-api.com' };
    }
  } catch (_) {}
  return { rates: FX_FALLBACK, base: 'USD', updated: null, source: 'fallback' };
}

async function getGold() {
  try {
    const data = await fetchJSON(GOLD_URL);
    const sym = data && Array.isArray(data.symbols) ? data.symbols[0] : null;
    const close = sym && Number(sym.close);
    if (close && close > 100 && close < 100000) {
      return { usd_per_oz: close, updated: `${sym.date} ${sym.time}`, source: 'stooq' };
    }
  } catch (_) {}
  return { usd_per_oz: GOLD_FALLBACK_USD_PER_TROY_OZ, updated: null, source: 'fallback' };
}

async function getSilver() {
  try {
    const data = await fetchJSON(SILVER_URL);
    const sym = data && Array.isArray(data.symbols) ? data.symbols[0] : null;
    const close = sym && Number(sym.close);
    if (close && close > 1 && close < 5000) {
      return { usd_per_oz: close, updated: `${sym.date} ${sym.time}`, source: 'stooq' };
    }
  } catch (_) {}
  return { usd_per_oz: null, updated: null, source: 'fallback' };
}

export default async function handler() {
  const [fx, gold, silver] = await Promise.all([getFx(), getGold(), getSilver()]);
  const body = JSON.stringify({
    fetched_at: new Date().toISOString(),
    fx,
    gold,
    silver
  });
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      // Edge cache: serve stale up to 10 min, revalidate in background up to 30 min
      'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=1800'
    }
  });
}
