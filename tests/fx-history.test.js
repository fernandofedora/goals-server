import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app.js';
import {
  FxRate,
  FxRateDaily,
  InvestmentHolding,
  InvestmentPurchase,
  MarketQuote,
} from '../src/models/index.js';
import { getHistoricalRates, resetFxHistoryState } from '../src/services/fx.js';
import { createUser } from './helpers.js';

const DAYS = ['2025-01-10', '2025-06-02', '2026-01-10'];

// Stands in for the history source; any other URL (the live-rates source)
// fails, so a test never reaches the network.
function stubHistory(usd) {
  const fn = vi.fn(async (url) => {
    if (String(url).includes('currency-api') && usd)
      return { ok: true, json: async () => ({ date: 'x', usd }) };
    throw new Error('offline');
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(async () => {
  resetFxHistoryState();
  await FxRateDaily.destroy({ where: { date: DAYS } });
});
afterEach(() => vi.unstubAllGlobals());

describe('getHistoricalRates', () => {
  it('uses stored days without calling the source', async () => {
    const fetch = stubHistory(null);
    await FxRateDaily.bulkCreate([
      { date: '2025-01-10', currency: 'NIO', ratePerUsd: 36.8 },
      { date: '2025-01-10', currency: 'EUR', ratePerUsd: 0.8 },
    ]);
    const usdNio = await getHistoricalRates('USD', 'NIO', ['2025-01-10']);
    const eurNio = await getHistoricalRates('EUR', 'NIO', ['2025-01-10']);
    expect(usdNio.get('2025-01-10')).toBeCloseTo(36.8);
    expect(eurNio.get('2025-01-10')).toBeCloseTo(46);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fetches a missing day once and keeps it', async () => {
    const fetch = stubHistory({ nio: 36.5, eur: 0.9, btc: 0.00000001, '1inch': 4 });
    const first = await getHistoricalRates('USD', 'NIO', ['2025-06-02']);
    expect(first.get('2025-06-02')).toBeCloseTo(36.5);
    expect(fetch).toHaveBeenCalledTimes(1);

    const stored = await FxRateDaily.findAll({ where: { date: '2025-06-02' } });
    expect(stored.map((r) => r.currency).sort()).toEqual(['EUR', 'NIO']);

    await getHistoricalRates('USD', 'NIO', ['2025-06-02']);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('leaves out days it cannot know', async () => {
    const fetch = stubHistory(null);
    const rates = await getHistoricalRates('USD', 'NIO', ['2025-06-02', '2023-05-01']);
    expect(rates.size).toBe(0);
    // Both mirrors tried for the day in range; none before the history starts.
    expect(fetch).toHaveBeenCalledTimes(2);
    // A failed day is not retried right away.
    await getHistoricalRates('USD', 'NIO', ['2025-06-02']);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('investments after the user changed currency', () => {
  let user;
  let auth;
  let holding;

  beforeEach(async () => {
    stubHistory(null);
    // Today's rates, fresh so the live source is not called.
    await FxRate.destroy({ where: {} });
    await FxRate.bulkCreate([
      { currency: 'NIO', ratePerUsd: 36.6, fetchedAt: new Date(), sourceUpdatedAt: new Date() },
    ]);
    await FxRateDaily.create({ date: '2026-01-10', currency: 'NIO', ratePerUsd: 36 });

    ({ user, auth } = await createUser());
    // Bought while their currency was USD; NIO since.
    await user.update({ currency: 'NIO', canAccessInvestments: true });
    const symbol = `QH${Math.random().toString(36).slice(2, 7)}`.toUpperCase();
    holding = await InvestmentHolding.create({
      UserId: user.id,
      symbol,
      providerSymbol: symbol,
      name: 'QA History',
      assetType: 'etf',
      quoteCurrency: 'USD',
      status: 'active',
    });
    await MarketQuote.upsert({
      providerSymbol: symbol,
      price: 120,
      currency: 'USD',
      quotedAt: new Date(),
      fetchedAt: new Date(),
    });
  });

  const buy = (date) =>
    InvestmentPurchase.create({
      InvestmentHoldingId: holding.id,
      date,
      shares: 10,
      pricePerShare: 100,
      amountQuote: 1000,
      userCurrency: 'USD',
      fxRate: 1,
      amountUser: 1000,
    });
  const first = async () =>
    (await request(app).get('/api/investments').set(auth)).body.holdings[0];

  it('converts old purchases at the rate of their date', async () => {
    await buy('2026-01-10');
    expect(await first()).toMatchObject({
      displayCurrency: 'NIO',
      costUser: 36000,
      valueUser: 43920,
      gainFxUser: 600,
      costFxEstimated: false,
    });
  });

  it("falls back to today's rate, flagged, when the date has no rate", async () => {
    await buy('2023-05-01');
    expect(await first()).toMatchObject({
      costUser: 36600,
      gainFxUser: 0,
      costFxEstimated: true,
    });
  });
});
