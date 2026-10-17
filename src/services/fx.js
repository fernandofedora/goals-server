import { FxRate } from '../models/index.js';

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
  return {
    rates: new Map(rows.map((r) => [r.currency, Number(r.ratePerUsd)])),
    fetchedAt,
    sourceUpdatedAt,
  };
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
