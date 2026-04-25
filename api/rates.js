// Vercel Edge function — proxies live FX + gold + silver to the browser.
// Browser hits /api/rates and gets a unified JSON.
// Edge-cached for 10 min (s-maxage), so upstreams are hit at most ~6/hour per region.

export const config = { runtime: 'edge' };

const FX_URL = 'https://open.er-api.com/v6/latest/USD';
const UA = 'Mozilla/5.0 (compatible; AlBills/1.0; +https://www.albills.com)';

const FX_FALLBACK = {
  USD: 1, AED: 3.6725, SAR: 3.75, EUR: 0.92, GBP: 0.79, INR: 83.5, PKR: 278,
  BDT: 110, EGP: 30.9, KWD: 0.307, QAR: 3.64, OMR: 0.385, JPY: 149.5,
  CNY: 7.24, SGD: 1.34, AUD: 1.53, CAD: 1.36, CHF: 0.88, TRY: 32.1,
  NGN: 1580, ZAR: 18.9, MYR: 4.72, PHP: 56.5
};
const GOLD_FALLBACK = 2385;

async function fetchJSON(url, timeoutMs = 4500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, 'Accept': 'application/json,text/javascript,*/*' } });
    if (!r.ok) throw new Error(`status ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

async function getFx() {
  try {
    const data = await fetchJSON(FX_URL);
    if (data && data.rates && Object.keys(data.rates).length > 50) {
      return {
        rates: data.rates,
        base: data.base_code || 'USD',
        updated: data.time_last_update_unix || null,
        source: 'open.er-api.com'
      };
    }
  } catch (_) {}
  return { rates: FX_FALLBACK, base: 'USD', updated: null, source: 'fallback' };
}

// Try Yahoo Finance gold futures, then Swissquote spot, then Stooq.
async function getMetal(yahooSym, swissPair, stooqSym) {
  // 1. Yahoo Finance futures
  try {
    const data = await fetchJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${yahooSym}?interval=1d&range=1d`);
    const m = data && data.chart && data.chart.result && data.chart.result[0] && data.chart.result[0].meta;
    const price = m && Number(m.regularMarketPrice);
    if (price && price > 1 && price < 200000) {
      return {
        usd_per_oz: price,
        updated: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toUTCString() : null,
        source: 'yahoo-finance'
      };
    }
  } catch (_) {}
  // 2. Swissquote spot mid-price
  try {
    const data = await fetchJSON(`https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/${swissPair[0]}/${swissPair[1]}`);
    const item = Array.isArray(data) ? data[0] : null;
    const profile = item && item.spreadProfilePrices && item.spreadProfilePrices[0];
    if (profile && profile.bid && profile.ask) {
      const mid = (Number(profile.bid) + Number(profile.ask)) / 2;
      if (mid > 1 && mid < 200000) {
        return {
          usd_per_oz: mid,
          updated: item.ts ? new Date(item.ts).toUTCString() : null,
          source: 'swissquote'
        };
      }
    }
  } catch (_) {}
  // 3. Stooq close
  try {
    const data = await fetchJSON(`https://stooq.com/q/l/?s=${stooqSym}&f=sd2t2ohlcv&h&e=json`);
    const sym = data && Array.isArray(data.symbols) ? data.symbols[0] : null;
    const close = sym && Number(sym.close);
    if (close && close > 1 && close < 200000) {
      return { usd_per_oz: close, updated: `${sym.date} ${sym.time} UTC`, source: 'stooq' };
    }
  } catch (_) {}
  return null;
}

async function getGold() {
  const r = await getMetal('GC=F', ['XAU', 'USD'], 'xauusd');
  return r || { usd_per_oz: GOLD_FALLBACK, updated: null, source: 'fallback' };
}

async function getSilver() {
  const r = await getMetal('SI=F', ['XAG', 'USD'], 'xagusd');
  return r || { usd_per_oz: null, updated: null, source: 'fallback' };
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
      'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=1800'
    }
  });
}
