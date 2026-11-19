import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app.js';
import {
  InvestmentHolding,
  InvestmentPurchase,
  MarketQuote,
  NetWorthSnapshot,
  Transaction,
} from '../src/models/index.js';
import { recordNetWorthSnapshots } from '../src/services/netWorth.js';
import { createAccount, createCategory, createUser } from './helpers.js';

let user;
let auth;
let bank;

const move = (type, amount, date, account = bank) =>
  Transaction.create({
    description: type,
    type,
    amount,
    date,
    paymentMethod: 'account',
    AccountId: account.id,
    UserId: user.id,
  });

async function addHolding({ shares, cost, date, price }) {
  const symbol = `QA${Math.random().toString(36).slice(2, 7)}`.toUpperCase();
  const holding = await InvestmentHolding.create({
    UserId: user.id,
    symbol,
    providerSymbol: symbol,
    name: 'QA Fund',
    assetType: 'etf',
    quoteCurrency: 'USD',
    status: 'active',
  });
  await InvestmentPurchase.create({
    InvestmentHoldingId: holding.id,
    UserId: user.id,
    date,
    shares,
    pricePerShare: cost / shares,
    amountQuote: cost,
    userCurrency: 'USD',
    fxRate: 1,
    amountUser: cost,
  });
  await MarketQuote.upsert({
    providerSymbol: symbol,
    price,
    currency: 'USD',
    quotedAt: new Date(),
    fetchedAt: new Date(),
  });
  return holding;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-03-20T12:00:00'));
  ({ user, auth } = await createUser());
  await user.update({ currency: 'USD' });
  bank = await createAccount(user, 'Banco', { initialBalance: 1000 });
  const isolated = await createAccount(user, 'Aparte', {
    initialBalance: 5000,
    isExcludedFromTotals: true,
  });
  await createCategory(user, 'Comida');
  await move('income', 500, '2026-01-15');
  await move('expense', 200, '2026-02-10');
  await move('income', 300, '2026-03-05');
  await move('expense', 100, '2026-04-02'); // future-dated, counts today
  await move('income', 999, '2026-03-01', isolated);
});
afterEach(() => vi.useRealTimers());

const get = () => request(app).get('/api/stats/net-worth').set(auth);

describe('GET /api/stats/net-worth', () => {
  it('sums integrated accounts like the Accounts page, month by month', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.includesInvestments).toBe(false);
    // 1000 + 500 - 200 + 300 - 100 (future-dated rows count today)
    expect(res.body.current).toMatchObject({
      accounts: 1500,
      investments: 0,
      total: 1500,
    });
    expect(res.body.history).toHaveLength(12);
    const at = (m) => res.body.history.find((h) => h.month === m);
    expect(at('2026-01').total).toBe(1500); // 1000 + 500
    expect(at('2026-02').total).toBe(1300);
    expect(at('2026-03').total).toBe(1500);
    expect(at('2025-12').total).toBe(1000);
    expect(res.body.changeMonth).toEqual({ amount: 200, percent: 15.4 });
  });

  it('leaves investments out for users without access', async () => {
    await addHolding({ shares: 10, cost: 800, date: '2026-01-10', price: 100 });
    const res = await get();
    expect(res.body.current.investments).toBe(0);
  });

  it('adds investments at market value today and at cost for past months', async () => {
    await user.update({ canAccessInvestments: true });
    await addHolding({ shares: 10, cost: 800, date: '2026-02-10', price: 100 });
    const res = await get();
    expect(res.body.includesInvestments).toBe(true);
    expect(res.body.current).toMatchObject({
      accounts: 1500,
      investments: 1000,
      total: 2500,
    });
    const at = (m) => res.body.history.find((h) => h.month === m);
    expect(at('2026-01').investments).toBe(0);
    expect(at('2026-02').investments).toBe(800);
  });

  it('uses the saved month close instead of cost', async () => {
    await user.update({ canAccessInvestments: true });
    await addHolding({ shares: 10, cost: 800, date: '2026-02-10', price: 100 });
    vi.setSystemTime(new Date('2026-02-28T23:50:00'));
    await MarketQuote.update(
      { price: 90, quotedAt: new Date(), fetchedAt: new Date() },
      { where: {} },
    );
    expect(await recordNetWorthSnapshots()).toBeGreaterThanOrEqual(1);
    const snap = await NetWorthSnapshot.findOne({ where: { UserId: user.id } });
    expect(snap.date).toBe('2026-02-28');
    expect(Number(snap.investments)).toBe(900);

    vi.setSystemTime(new Date('2026-03-20T12:00:00'));
    await MarketQuote.update(
      { price: 100, quotedAt: new Date(), fetchedAt: new Date() },
      { where: {} },
    );
    const res = await get();
    expect(
      res.body.history.find((h) => h.month === '2026-02').investments,
    ).toBe(900);
  });
});
