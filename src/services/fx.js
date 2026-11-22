import { FxRate, FxRateDaily } from '../models/index.js';

// ExchangeRate-API open endpoint: no key, ~166 currencies, updated once a day.
// Attribution is required by its terms (shown in the client's beta banner).
const FX_URL = 'https://open.er-api.com/v6/latest/USD';
const FX_TTL_HOURS = Number(process.env.FX_TTL_HOURS) || 12;

// In-memory copy of the FxRate table so conversions don't hit the DB per call.
let cache = null; // { rates: Map<currency, number>, fetchedAt: Date, sourceUpdatedAt: Date|null }
let inflight = null;
// After a failed refresh, keep serving stored rates for a while instead of
// hitting the source again on every request.
const RETRY_AFTER_FAILURE_MS = 10 * 60 * 1000;
let lastFailureAt = 0;

const isFresh = (c) =>
  c && Date.now() - c.fetchedAt.getTime() < FX_TTL_HOURS * 3600 * 1000;

async function loadFromDb() {
  const rows = await FxRate.findAll();
  if (!rows.length) return null;
  const rates = new Map(rows.map((r) => [r.currency, Number(r.ratePerUsd)]));
  // All rows are written together, so the oldest fetchedAt is the batch's.
  const fetchedAt = new Date(
    Math.min(...rows.map((r) => r.fetchedAt.getTime())),
  );
  return { rates, fetchedAt, sourceUpdatedAt: rows[0].sourceUpdatedAt };
}

async function fetchFromSource() {
  const res = await fetch(FX_URL);
  if (!res.ok) throw new Error(`FX source HTTP ${res.status}`);
  const body = await res.json();
  if (body.result !== 'success' || !body.rates) {
    throw new Error(`FX source error: ${body['error-type'] || 'unknown'}`);
  }
  const fetchedAt = new Date();
  const sourceUpdatedAt = body.time_last_update_unix
    ? new Date(body.time_last_update_unix * 1000)
    : null;
  const rows = Object.entries(body.rates).map(([currency, rate]) => ({
    currency,
    ratePerUsd: rate,
    sourceUpdatedAt,
    fetchedAt,
  }));
  await FxRate.bulkCreate(rows, {
    updateOnDuplicate: [
      'ratePerUsd',
      'sourceUpdatedAt',
      'fetchedAt',
      'updatedAt',
    ],
  });
  const fresh = {
    rates: new Map(rows.map((r) => [r.currency, Number(r.ratePerUsd)])),
    fetchedAt,
    sourceUpdatedAt,
  };
  await recordToday(fresh);
  return fresh;
}

/**
 * Returns the rate table, refreshing from the source when older than
 * FX_TTL_HOURS. If the source is down, keeps serving the last stored rates.
 */
export async function getRates({ force = false } = {}) {
  if (!force && isFresh(cache)) return cache;
  if (!force && cache && Date.now() - lastFailureAt < RETRY_AFTER_FAILURE_MS) {
    return cache;
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      if (!force && !cache) {
        cache = await loadFromDb();
        if (isFresh(cache)) return cache;
      }
      cache = await fetchFromSource();
      return cache;
    } catch (err) {
      lastFailureAt = Date.now();
      console.error('FX refresh failed:', err.message);
      if (!cache) cache = await loadFromDb().catch(() => null);
      if (!cache) throw err;
      return cache;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Rate to convert 1 unit of `from` into `to` (via USD). Returns null when one of
 * the currencies is unknown, so callers can fall back to the quote currency.
 */
export async function getRate(from, to) {
  if (!from || !to) return null;
  if (from === to) return 1;
  const { rates } = await getRates();
  const fromPerUsd = from === 'USD' ? 1 : rates.get(from);
  const toPerUsd = to === 'USD' ? 1 : rates.get(to);
  if (!fromPerUsd || !toPerUsd) return null;
  return toPerUsd / fromPerUsd;
}

/** Date of the rates in use (as published by the source). */
export async function getRatesDate() {
  const c = await getRates();
  return c.sourceUpdatedAt || c.fetchedAt;
}

// --- History -----------------------------------------------------------------
//
// Past rates come from FxRateDaily. Each refresh above stores that day's
// rates there; older days are fetched once from fawazahmed0/currency-api
// (free, no key, daily since 2024-03-02, two mirrors) and kept.

const HISTORY_START = '2024-03-02';
const historyUrls = (day) => [
  `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${day}/v1/currencies/usd.json`,
  `https://${day}.currency-api.pages.dev/v1/currencies/usd.json`,
];
const HISTORY_TIMEOUT_MS = 5000;
// Days fetched per request: the rest are fetched on the next one.
const MAX_HISTORY_FETCHES = 12;
const HISTORY_CONCURRENCY = 4;
const failedDays = new Map(); // day -> time of the last failed fetch
const inflightDays = new Map(); // day -> Promise<Map|null>

const dayOf = (d) =>
  d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);

// Plain ISO codes only (the source also lists crypto and odd units).
const isStorable = (code, rate) =>
  /^[A-Z]{3}$/.test(code) && Number.isFinite(rate) && rate >= 1e-6 && rate < 1e13;

async function saveDay(day, rates) {
  const rows = [...rates]
    .filter(([code, rate]) => isStorable(code, rate))
    .map(([currency, ratePerUsd]) => ({ date: day, currency, ratePerUsd }));
  if (!rows.length) return;
  await FxRateDaily.bulkCreate(rows, { updateOnDuplicate: ['ratePerUsd', 'updatedAt'] });
}

/** Stores the current rates as the history of the day they're from. */
async function recordToday({ rates, sourceUpdatedAt, fetchedAt }) {
  await saveDay(dayOf(sourceUpdatedAt || fetchedAt), rates).catch((err) =>
    console.error('FX history save failed:', err.message),
  );
}

async function fetchDay(day) {
  for (const url of historyUrls(day)) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(HISTORY_TIMEOUT_MS) });
      if (!res.ok) continue;
      const body = await res.json();
      if (!body?.usd) continue;
      const rates = new Map(
        Object.entries(body.usd).map(([code, rate]) => [code.toUpperCase(), Number(rate)]),
      );
      await saveDay(day, rates);
      return rates;
    } catch {
      // try the mirror
    }
  }
  failedDays.set(day, Date.now());
  return null;
}

function fetchDayOnce(day) {
  if (!inflightDays.has(day)) {
    inflightDays.set(
      day,
      fetchDay(day).finally(() => inflightDays.delete(day)),
    );
  }
  return inflightDays.get(day);
}

const recentlyFailed = (day) =>
  Date.now() - (failedDays.get(day) || 0) < RETRY_AFTER_FAILURE_MS;

const rateFrom = (perUsd, from, to) => {
  const f = from === 'USD' ? 1 : perUsd.get(from);
  const t = to === 'USD' ? 1 : perUsd.get(to);
  return f && t ? t / f : null;
};

/**
 * Rate from `from` to `to` on each of `dates` (YYYY-MM-DD). Today and later
 * use the current rate. A day with no known rate (before the history starts,
 * or the source is down) is left out of the map: callers fall back to today's.
 */
export async function getHistoricalRates(from, to, dates) {
  const out = new Map();
  if (!from || !to) return out;
  const days = [...new Set(dates.map(dayOf))];
  if (from === to) {
    for (const d of days) out.set(d, 1);
    return out;
  }

  const today = dayOf(new Date());
  const past = days.filter((d) => d < today);
  if (days.length > past.length) {
    const current = await getRate(from, to);
    if (current) for (const d of days) if (d >= today) out.set(d, current);
  }
  if (!past.length) return out;

  const codes = [from, to].filter((c) => c !== 'USD');
  const known = new Map(); // day -> Map(currency -> perUsd)
  const stored = await FxRateDaily.findAll({ where: { date: past, currency: codes } });
  for (const r of stored) {
    const day = dayOf(r.date);
    if (!known.has(day)) known.set(day, new Map());
    known.get(day).set(r.currency, Number(r.ratePerUsd));
  }

  const missing = past
    .filter((d) => !rateFrom(known.get(d) || new Map(), from, to))
    .filter((d) => d >= HISTORY_START && !recentlyFailed(d))
    .slice(0, MAX_HISTORY_FETCHES);
  for (let i = 0; i < missing.length; i += HISTORY_CONCURRENCY) {
    const batch = missing.slice(i, i + HISTORY_CONCURRENCY);
    const fetched = await Promise.all(batch.map(fetchDayOnce));
    batch.forEach((d, j) => fetched[j] && known.set(d, fetched[j]));
  }

  for (const d of past) {
    const rate = known.has(d) ? rateFrom(known.get(d), from, to) : null;
    if (rate) out.set(d, rate);
  }
  return out;
}

/** Test hook: forget failed and in-flight history fetches. */
export function resetFxHistoryState() {
  failedDays.clear();
  inflightDays.clear();
}
