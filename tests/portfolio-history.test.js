import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import {
  InvestmentHolding,
  InvestmentPurchase,
  MarketQuote,
  PortfolioSnapshot,
} from '../src/models/index.js';
import {
  localDay,
  recordPortfolioSnapshots,
} from '../src/services/portfolioHistory.js';
import { createUser } from './helpers.js';

// Everything is in USD, so no exchange rate (or network) is involved.
async function investor({ access = true } = {}) {
  const { user, auth } = await createUser();
  await user.update({ currency: 'USD', canAccessInvestments: access });
  const symbol = `QS${Math.random().toString(36).slice(2, 7)}`.toUpperCase();
  const holding = await InvestmentHolding.create({
    UserId: user.id,
    symbol,
    providerSymbol: symbol,
    name: 'QA Snapshot',
    assetType: 'etf',
    quoteCurrency: 'USD',
    status: 'active',
  });
  await InvestmentPurchase.create({
    InvestmentHoldingId: holding.id,
    date: '2026-01-10',
    shares: 10,
    pricePerShare: 100,
    amountQuote: 1000,
    userCurrency: 'USD',
    fxRate: 1,
    amountUser: 1000,
  });
  await MarketQuote.upsert({
    providerSymbol: symbol,
    price: 125,
    currency: 'USD',
    quotedAt: new Date(),
    fetchedAt: new Date(),
  });
  return { user, auth };
}

const snapshotsOf = (user) =>
  PortfolioSnapshot.findAll({ where: { UserId: user.id }, raw: true });

describe('portfolio snapshots', () => {
  it('saves today when the investments page loads', async () => {
    const { user, auth } = await investor();
    expect((await request(app).get('/api/investments').set(auth)).status).toBe(200);
    // Saved after the response: wait for it.
    let rows = [];
    for (let i = 0; i < 20 && !rows.length; i++) {
      rows = await snapshotsOf(user);
      if (!rows.length) await new Promise((r) => setTimeout(r, 50));
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ date: localDay(), currency: 'USD' });
    expect(Number(rows[0].value)).toBe(1250);
    expect(Number(rows[0].cost)).toBe(1000);
  });

  it('the daily job saves one row per investor and day', async () => {
    const { user } = await investor();
    const { user: noAccess } = await investor({ access: false });
    await recordPortfolioSnapshots();
    await recordPortfolioSnapshots();
    const rows = await snapshotsOf(user);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].value)).toBe(1250);
    expect(await snapshotsOf(noAccess)).toHaveLength(0);
  });
});

describe('GET /api/investments/history', () => {
  let user;
  let auth;
  const daysAgo = (n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return localDay(d);
  };

  beforeEach(async () => {
    ({ user, auth } = await investor());
    await PortfolioSnapshot.bulkCreate([
      { UserId: user.id, date: daysAgo(200), value: 900, cost: 1000, currency: 'USD' },
      { UserId: user.id, date: daysAgo(40), value: 1100, cost: 1000, currency: 'USD' },
      { UserId: user.id, date: daysAgo(10), value: 1200, cost: 1000, currency: 'USD' },
      // Saved before the user switched to USD: left out.
      { UserId: user.id, date: daysAgo(5), value: 44000, cost: 36000, currency: 'NIO' },
    ]);
  });

  const history = (range) =>
    request(app)
      .get('/api/investments/history')
      .query(range ? { range } : {})
      .set(auth);

  it('returns the points of the range, oldest first, in the user currency', async () => {
    const res = await history('1m');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ currency: 'USD', range: '1m' });
    expect(res.body.points).toEqual([{ date: daysAgo(10), value: 1200, cost: 1000 }]);

    expect((await history('all')).body.points.map((p) => p.value)).toEqual([900, 1100, 1200]);
  });

  it('defaults to three months on a missing or unknown range', async () => {
    for (const range of [undefined, 'toString', '5y']) {
      const res = await history(range);
      expect(res.body.range).toBe('3m');
      expect(res.body.points.map((p) => p.value)).toEqual([1100, 1200]);
    }
  });

  it('needs investments access', async () => {
    const { auth: other } = await investor({ access: false });
    expect((await request(app).get('/api/investments/history').set(other)).status).toBe(403);
  });
});
