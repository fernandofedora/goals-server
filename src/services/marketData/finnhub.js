// Finnhub adapter. Free plan: US quotes only (other exchanges return 403),
// 60 calls/min. /search is weak by name and has no currency/exchange, so search
// runs locally against the /stock/symbol catalog instead (see index.js).
const BASE_URL = 'https://finnhub.io/api/v1';

export const PROVIDER = 'finnhub';

// Catalog types worth offering in search; the rest (warrants, rights, units…)
// only add noise.
const USEFUL_TYPES = new Set([
  'Common Stock',
  'ETP',
  'ADR',
  'REIT',
  'Closed-End Fund',
]);
// OTC: ~17k thinly traded symbols that drown out real results.
const EXCLUDED_MICS = new Set(['OOTC']);

// Last rate-limit headers seen, shared by all calls in this process.
const rateLimit = { remaining: null, resetAt: 0 };

export class ProviderError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function apiKey() {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) throw new ProviderError('FINNHUB_API_KEY is not configured', 500);
  return key;
}

/** True when we know the per-minute budget is spent and not yet reset. */
export function isRateLimited() {
  return (
    rateLimit.remaining !== null &&
    rateLimit.remaining <= 0 &&
    Date.now() < rateLimit.resetAt
  );
}

async function request(path, params = {}) {
  const url = new URL(BASE_URL + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('token', apiKey());

  // fetch follows the 302 that /stock/symbol answers with.
  const res = await fetch(url);
  const remaining = res.headers.get('x-ratelimit-remaining');
  const reset = res.headers.get('x-ratelimit-reset');
  if (remaining !== null) rateLimit.remaining = Number(remaining);
  if (reset !== null) rateLimit.resetAt = Number(reset) * 1000;

  if (res.status === 429) {
    rateLimit.remaining = 0;
    if (!rateLimit.resetAt || rateLimit.resetAt < Date.now()) {
      rateLimit.resetAt = Date.now() + 60 * 1000;
    }
    throw new ProviderError('Rate limit exceeded', 429);
  }
  // Never include the URL in errors: it carries the API key.
  if (!res.ok)
    throw new ProviderError(
      `Finnhub HTTP ${res.status} on ${path}`,
      res.status,
    );
  return res.json();
}

const toAssetType = (type) => {
  if (type === 'ETP') return 'etf';
  if (type === 'Common Stock' || type === 'ADR' || type === 'REIT')
    return 'stock';
  return 'other';
};

/** Full symbol list for one exchange code (e.g. 'US'), normalized and filtered. */
export async function fetchCatalog(exchange) {
  const list = await request('/stock/symbol', { exchange });
  return list
    .filter(
      (s) =>
        s.symbol &&
        s.description &&
        USEFUL_TYPES.has(s.type) &&
        !EXCLUDED_MICS.has(s.mic),
    )
    .map((s) => ({
      providerSymbol: s.symbol,
      provider: PROVIDER,
      symbol: (s.displaySymbol || s.symbol).slice(0, 20),
      name: s.description.slice(0, 255),
      type: s.type,
      mic: s.mic || null,
      currency: s.currency || null,
      figi: s.figi || null,
    }));
}

/**
 * Latest quote for one symbol, or null when the provider doesn't know it
 * (Finnhub answers unknown symbols with all-zero fields instead of a 404).
 */
export async function fetchQuote(providerSymbol) {
  const q = await request('/quote', { symbol: providerSymbol });
  if (!q || !q.c || !q.t) return null;
  return {
    price: q.c,
    previousClose: q.pc ?? null,
    change: q.d ?? null,
    changePercent: q.dp ?? null,
    quotedAt: new Date(q.t * 1000),
  };
}

export { toAssetType };
