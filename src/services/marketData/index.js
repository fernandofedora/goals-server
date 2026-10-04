import { Op } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { MarketQuote, MarketSymbol } from '../../models/index.js';
import * as finnhub from './finnhub.js';

// Only Finnhub for the MVP; a second adapter (e.g. Twelve Data for non-US
// exchanges) plugs in here with the same fetchCatalog/fetchQuote shape.
const PROVIDERS = { finnhub };
const provider =
  PROVIDERS[(process.env.MARKET_DATA_PROVIDER || 'finnhub').toLowerCase()] ||
  finnhub;

const QUOTE_TTL_MS = (Number(process.env.QUOTE_TTL_SECONDS) || 60) * 1000;
// Catalog exchange codes to sync (Finnhub: 'US'). Widening this is phase 4.
const CATALOG_EXCHANGES = (process.env.MARKET_ALLOWED_EXCHANGES || 'US')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// Max provider calls a single request may trigger, so one big portfolio can't
// burn the whole per-minute budget; the rest is served from cache as stale.
const MAX_FETCHES_PER_CALL = 20;
const FETCH_CONCURRENCY = 4;

export const toAssetType = provider.toAssetType;

// --- Catalog -----------------------------------------------------------------

let catalogSync = null;

/** Download the provider's symbol list and upsert it into MarketSymbol. */
export function syncCatalog() {
  if (catalogSync) return catalogSync;
  catalogSync = (async () => {
    // DATETIME columns drop milliseconds (MySQL may round them), so take the
    // cut-off one whole second earlier: a row upserted now can never look
    // older than it and be deleted as "delisted".
    const startedAt = new Date(Math.floor(Date.now() / 1000) * 1000 - 1000);
    let total = 0;
    for (const exchange of CATALOG_EXCHANGES) {
      const rows = await provider.fetchCatalog(exchange);
      for (let i = 0; i < rows.length; i += 1000) {
        await MarketSymbol.bulkCreate(rows.slice(i, i + 1000), {
          updateOnDuplicate: [
            'provider',
            'symbol',
            'name',
            'type',
            'mic',
            'currency',
            'figi',
            'updatedAt',
          ],
        });
      }
      total += rows.length;
    }
    // Drop delisted symbols, but only after a plausible sync so a bad/empty
    // provider response can never wipe the catalog.
    if (total > 1000) {
      const removed = await MarketSymbol.destroy({
        where: {
          provider: provider.PROVIDER,
          updatedAt: { [Op.lt]: startedAt },
        },
      });
      if (removed)
        console.log(`Market catalog: removed ${removed} delisted symbol(s)`);
    }
    console.log(`Market catalog synced: ${total} symbol(s)`);
    return total;
  })().finally(() => {
    catalogSync = null;
  });
  return catalogSync;
}

/** Sync the catalog only if it's empty (first boot / fresh database). */
export async function ensureCatalog() {
  const count = await MarketSymbol.count();
  if (count === 0) await syncCatalog();
}

export function getSymbol(providerSymbol) {
  return MarketSymbol.findByPk(providerSymbol);
}

const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);

/**
 * Local search over MarketSymbol: exact ticker first, then ticker prefix, then
 * names containing every word of the query. No provider calls.
 */
export async function search(query, limit = 15) {
  const q = String(query || '')
    .trim()
    .slice(0, 50);
  if (!q) return [];
  const upper = q.toUpperCase();
  const words = q.split(/\s+/).filter(Boolean).slice(0, 5);

  const rows = await MarketSymbol.findAll({
    where: {
      [Op.or]: [
        { symbol: { [Op.like]: `${escapeLike(upper)}%` } },
        {
          [Op.and]: words.map((w) => ({
            name: { [Op.like]: `%${escapeLike(w)}%` },
          })),
        },
      ],
    },
    order: [
      [
        sequelize.literal(
          `CASE WHEN symbol = ${sequelize.escape(upper)} THEN 0
                WHEN symbol LIKE ${sequelize.escape(escapeLike(upper) + '%')} THEN 1
                WHEN name LIKE ${sequelize.escape(escapeLike(q) + '%')} THEN 2
                ELSE 3 END`,
        ),
        'ASC',
      ],
      // Plain stocks and ETFs before ADRs/REITs/funds, shorter tickers first.
      [
        sequelize.literal(
          `CASE WHEN type IN ('ETP','Common Stock') THEN 0 ELSE 1 END`,
        ),
        'ASC',
      ],
      [sequelize.fn('CHAR_LENGTH', sequelize.col('symbol')), 'ASC'],
      ['symbol', 'ASC'],
    ],
    limit,
  });
  return rows.map(formatSymbol);
}

export const formatSymbol = (s) => ({
  providerSymbol: s.providerSymbol,
  symbol: s.symbol,
  name: s.name,
  type: s.type,
  assetType: toAssetType(s.type),
  mic: s.mic,
  currency: s.currency,
});

// --- Quotes ------------------------------------------------------------------

const inflightQuotes = new Map(); // providerSymbol -> Promise

const isQuoteFresh = (row) =>
  row && Date.now() - new Date(row.fetchedAt).getTime() < QUOTE_TTL_MS;

async function refreshQuote(providerSymbol, currency) {
  if (inflightQuotes.has(providerSymbol))
    return inflightQuotes.get(providerSymbol);
  const p = (async () => {
    const q = await provider.fetchQuote(providerSymbol);
    if (!q) return null;
    const [row] = await MarketQuote.upsert({
      providerSymbol,
      ...q,
      currency,
      fetchedAt: new Date(),
    });
    return row;
  })().finally(() => inflightQuotes.delete(providerSymbol));
  inflightQuotes.set(providerSymbol, p);
  return p;
}

const formatQuote = (row, stale) => ({
  price: Number(row.price),
  previousClose: row.previousClose != null ? Number(row.previousClose) : null,
  change: row.change != null ? Number(row.change) : null,
  changePercent: row.changePercent != null ? Number(row.changePercent) : null,
  currency: row.currency,
  quotedAt: row.quotedAt,
  fetchedAt: row.fetchedAt,
  stale,
});

/**
 * Quotes for several symbols. Uses the shared cache when younger than
 * QUOTE_TTL_SECONDS; otherwise refreshes (bounded), falling back to the last
 * stored price with stale=true if the provider fails or is rate limited.
 * @param {{providerSymbol: string, currency: string}[]} items
 * @returns {Promise<Map<string, object>>} symbols with no price at all are absent
 */
export async function getQuotes(items) {
  const unique = [...new Map(items.map((i) => [i.providerSymbol, i])).values()];
  const result = new Map();
  if (!unique.length) return result;

  const cached = await MarketQuote.findAll({
    where: { providerSymbol: unique.map((i) => i.providerSymbol) },
  });
  const bySymbol = new Map(cached.map((r) => [r.providerSymbol, r]));

  const toRefresh = [];
  for (const item of unique) {
    const row = bySymbol.get(item.providerSymbol);
    if (isQuoteFresh(row))
      result.set(item.providerSymbol, formatQuote(row, false));
    else toRefresh.push(item);
  }

  const budget = toRefresh.slice(0, MAX_FETCHES_PER_CALL);
  for (let i = 0; i < budget.length; i += FETCH_CONCURRENCY) {
    if (provider.isRateLimited()) break;
    const chunk = budget.slice(i, i + FETCH_CONCURRENCY);
    const fresh = await Promise.allSettled(
      chunk.map((item) => refreshQuote(item.providerSymbol, item.currency)),
    );
    fresh.forEach((r, idx) => {
      const sym = chunk[idx].providerSymbol;
      if (r.status === 'fulfilled' && r.value) {
        result.set(sym, formatQuote(r.value, false));
      } else if (r.status === 'rejected') {
        console.warn(`Quote refresh failed for ${sym}: ${r.reason?.message}`);
      }
    });
  }

  // Anything not refreshed falls back to the last stored price.
  for (const item of toRefresh) {
    if (result.has(item.providerSymbol)) continue;
    const row = bySymbol.get(item.providerSymbol);
    if (row) result.set(item.providerSymbol, formatQuote(row, true));
  }
  return result;
}

export async function getQuote(providerSymbol, currency) {
  const quotes = await getQuotes([{ providerSymbol, currency }]);
  return quotes.get(providerSymbol) || null;
}
