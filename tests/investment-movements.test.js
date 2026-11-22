import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app.js';
import {
  InvestmentHolding,
  InvestmentPurchase,
  MarketQuote,
} from '../src/models/index.js';
import {
  gainSplit,
  holdingPosition,
  portfolioValue,
} from '../src/services/portfolio.js';
import { createUser } from './helpers.js';

// Only USD→NIO is known, at 36.6 today.
vi.mock('../src/services/fx.js', () => ({
  getRate: async (from, to) =>
    from === to ? 1 : from === 'USD' && to === 'NIO' ? 36.6 : null,
  getRatesDate: async () => new Date('2026-11-20T00:00:00Z'),
}));

const usd = { currency: 'USD', fxRate: 1 };
const mv = (type, date, shares, amount, id) => ({
  id,
  type,
  date,
  shares,
  amountQuote: amount,
  amountUser: amount,
  userCurrency: 'USD',
});

describe('holdingPosition', () => {
  it('uses average cost for sales and keeps dividends apart', () => {
    const pos = holdingPosition(
      [
        mv('buy', '2026-01-10', 10, 1000, 1),
        mv('buy', '2026-02-10', 10, 2000, 2),
        mv('sell', '2026-03-10', 5, 1000, 3),
        mv('dividend', '2026-03-15', 0, 30, 4),
      ],
      usd,
    );
    // Average cost 150/share: 5 sold cost 750, brought 1000.
    expect(pos).toMatchObject({
      shares: 15,
      costUser: 2250,
      realizedUser: 250,
      dividendsUser: 30,
      invalid: null,
    });
  });

  it('flags a sale of more shares than held at that date', () => {
    const pos = holdingPosition(
      [mv('buy', '2026-03-01', 5, 500, 1), mv('sell', '2026-02-01', 1, 100, 2)],
      usd,
    );
    expect(pos.invalid?.id).toBe(2);
  });

  it('counts a same-day buy before the sale, whatever the row order', () => {
    const pos = holdingPosition(
      [mv('sell', '2026-03-01', 2, 300, 1), mv('buy', '2026-03-01', 2, 200, 2)],
      usd,
    );
    expect(pos).toMatchObject({ shares: 0, costUser: 0, realizedUser: 100, invalid: null });
  });
});

describe('gainSplit', () => {
  it('splits the open gain into price and exchange rate', () => {
    // $1000 paid at 36 C$/$ (C$36,000); now worth $1200 at 36.6.
    const split = gainSplit({ valueQuote: 1200, costQuote: 1000, costUser: 36000, fxRate: 36.6 });
    expect(split.price).toBeCloseTo(7320);
    expect(split.fx).toBeCloseTo(600);
    expect(split.price + split.fx).toBeCloseTo(1200 * 36.6 - 36000);
  });

  it('is null without a price', () => {
    expect(gainSplit({ valueQuote: null, costQuote: 1, costUser: 1, fxRate: 1 })).toBeNull();
  });
});

describe('investments API with sales and dividends', () => {
  let user;
  let auth;
  let holding;
  let firstBuy;

  beforeEach(async () => {
    ({ user, auth } = await createUser());
    await user.update({ currency: 'USD', canAccessInvestments: true });
    const symbol = `QM${Math.random().toString(36).slice(2, 7)}`.toUpperCase();
    holding = await InvestmentHolding.create({
      UserId: user.id,
      symbol,
      providerSymbol: symbol,
      name: 'QA Fund',
      assetType: 'etf',
      quoteCurrency: 'USD',
      status: 'active',
    });
    firstBuy = await InvestmentPurchase.create({
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
      price: 120,
      currency: 'USD',
      quotedAt: new Date(),
      fetchedAt: new Date(),
    });
  });

  const add = (body) =>
    request(app).post(`/api/investments/${holding.id}/purchases`).set(auth).send(body);
  const list = async () => {
    const res = await request(app).get('/api/investments').set(auth);
    expect(res.status).toBe(200);
    return res.body;
  };

  it('records a sale and shows the realized gain', async () => {
    const sale = await add({ type: 'sell', date: '2026-02-01', shares: 4, pricePerShare: 150 });
    expect(sale.status).toBe(201);
    expect(sale.body).toMatchObject({ type: 'sell', shares: 4, amountQuote: 600 });

    const body = await list();
    const h = body.holdings[0];
    expect(h).toMatchObject({ shares: 6, costUser: 600, valueUser: 720, realizedUser: 200 });
    expect(body.totals).toMatchObject({ value: 720, cost: 600, realized: 200, totalReturn: 320 });
    expect(await portfolioValue(user.id, 'USD')).toBe(720);
  });

  it('records a dividend without touching shares or cost', async () => {
    const div = await add({ type: 'dividend', date: '2026-02-15', amount: 12.5 });
    expect(div.status).toBe(201);
    expect(div.body).toMatchObject({ type: 'dividend', shares: 0, amountUser: 12.5 });

    const { holdings, totals } = await list();
    expect(holdings[0]).toMatchObject({ shares: 10, costUser: 1000, dividendsUser: 12.5 });
    expect(totals.totalReturn).toBe(212.5);
  });

  it('refuses to sell more than was held, now or by editing history', async () => {
    expect((await add({ type: 'sell', date: '2026-02-01', shares: 11, pricePerShare: 100 })).status).toBe(400);
    expect((await add({ type: 'sell', date: '2026-01-05', shares: 1, pricePerShare: 100 })).status).toBe(400);

    await add({ type: 'sell', date: '2026-02-01', shares: 10, pricePerShare: 130 });
    const del = await request(app).delete(`/api/investments/purchases/${firstBuy.id}`).set(auth);
    expect(del.status).toBe(400);
    const shrink = await request(app)
      .put(`/api/investments/purchases/${firstBuy.id}`)
      .set(auth)
      .send({ shares: 5, pricePerShare: 100 });
    expect(shrink.status).toBe(400);

    const { holdings } = await list();
    expect(holdings[0]).toMatchObject({ shares: 0, soldOut: true, realizedUser: 300 });
  });

  it('keeps the type when a sale is edited', async () => {
    const sale = await add({ type: 'sell', date: '2026-02-01', shares: 2, pricePerShare: 150 });
    const edit = await request(app)
      .put(`/api/investments/purchases/${sale.body.id}`)
      .set(auth)
      .send({ type: 'buy', shares: 3, pricePerShare: 150 });
    expect(edit.status).toBe(200);
    expect(edit.body).toMatchObject({ type: 'sell', shares: 3 });
  });

  it('has no exchange-rate part when nothing is converted', async () => {
    const { holdings, totals } = await list();
    expect(holdings[0]).toMatchObject({ gainUser: 200, gainPriceUser: 200, gainFxUser: 0 });
    expect(totals).toMatchObject({ gain: 200, gainPrice: 200, gainFx: 0 });
  });

  it('splits the gain in the user currency into price and exchange rate', async () => {
    await user.update({ currency: 'NIO' });
    await firstBuy.update({ userCurrency: 'NIO', fxRate: 36, amountUser: 36000 });
    const sale = await add({ type: 'sell', date: '2026-02-01', shares: 5, pricePerShare: 110 });
    expect(sale.status).toBe(201);

    // 5 shares left: cost $500 / C$18,000; worth $600 at 36.6 (C$21,960).
    const { holdings, totals } = await list();
    expect(holdings[0]).toMatchObject({
      costUser: 18000,
      valueUser: 21960,
      gainUser: 3960,
      gainPriceUser: 3660,
      gainFxUser: 300,
    });
    expect(totals).toMatchObject({ gain: 3960, gainPrice: 3660, gainFx: 300 });
  });
});
