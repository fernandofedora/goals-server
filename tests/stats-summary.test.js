import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { Budget, Transaction } from '../src/models/index.js';
import {
  createAccount,
  createCard,
  createCategory,
  createUser,
} from './helpers.js';

let auth;
let otherAuth;

const summary = async (query) => {
  const res = await request(app)
    .get('/api/stats/summary')
    .query(query)
    .set(auth);
  expect(res.status).toBe(200);
  return res.body;
};

beforeAll(async () => {
  const main = await createUser();
  const other = await createUser();
  auth = main.auth;
  otherAuth = other.auth;
  const { user } = main;

  const food = await createCategory(user, 'Food', 'expense', {
    monthlyBudget: 300,
  });
  const rent = await createCategory(user, 'Rent');
  const salary = await createCategory(user, 'Salary', 'income');
  const card = await createCard(user);
  const bank = await createAccount(user);
  const isolated = await createAccount(user, 'Aislada', {
    isExcludedFromTotals: true,
  });

  const tx = (type, amount, date, paymentMethod, extra = {}) => ({
    type,
    amount,
    date,
    paymentMethod,
    description: 'x',
    UserId: user.id,
    ...extra,
  });
  await Transaction.bulkCreate([
    tx('income', 2000, '2026-01-01', 'account', {
      CategoryId: salary.id,
      AccountId: bank.id,
    }),
    tx('expense', 100.1, '2026-01-10', 'cash', { CategoryId: food.id }),
    tx('expense', 200.2, '2026-01-31', 'card', {
      CategoryId: food.id,
      CardId: card.id,
    }),
    tx('expense', 50.05, '2026-01-20', 'account', {
      CategoryId: rent.id,
      AccountId: bank.id,
    }),
    tx('expense', 30, '2026-02-01', 'cash', { CategoryId: food.id }),
    tx('income', 500, '2026-02-28', 'cash', { CategoryId: salary.id }),
    tx('expense', 11, '2026-03-01', 'cash', { CategoryId: food.id }),
    tx('expense', 7, '2025-12-31', 'cash'),
    tx('expense', 999, '2026-01-15', 'account', { AccountId: isolated.id }),
    tx('income', 5000, '2026-01-15', 'account', { AccountId: isolated.id }),
  ]);
  await Transaction.create({
    type: 'expense',
    amount: 777,
    date: '2026-01-15',
    paymentMethod: 'cash',
    description: 'other user',
    UserId: other.user.id,
  });
  await Budget.create({ month: 1, year: 2026, amount: 1500, UserId: user.id });
});

describe('GET /api/stats/summary', () => {
  it('requires a token', async () => {
    const res = await request(app).get('/api/stats/summary');
    expect(res.status).toBe(401);
  });

  it('rejects an invalid period', async () => {
    const res = await request(app)
      .get('/api/stats/summary')
      .query({ period: 'abc' })
      .set(auth);
    expect(res.status).toBe(400);
  });

  it('adds up a month, leaving out isolated accounts and other users', async () => {
    const { totals } = await summary({ period: '2026-01' });
    expect(totals.transactions).toBe(4);
    expect(totals.income).toBeCloseTo(2000, 2);
    expect(totals.expense).toBeCloseTo(350.35, 2);
    expect(totals.balance).toBeCloseTo(1649.65, 2);
  });

  it('only sees the data of the token owner', async () => {
    const res = await request(app)
      .get('/api/stats/summary')
      .query({ period: '2026-01' })
      .set(otherAuth);
    expect(res.body.totals.expense).toBeCloseTo(777, 2);
    expect(res.body.totals.transactions).toBe(1);
  });

  it('includes the first and last day of a month and nothing outside it', async () => {
    const { totals } = await summary({ period: '2026-02' });
    expect(totals.transactions).toBe(2);
    expect(totals.expense).toBeCloseTo(30, 2);
    expect(totals.income).toBeCloseTo(500, 2);
  });

  it('accepts a full year', async () => {
    const { totals, budgetAmount } = await summary({ period: '2026' });
    expect(totals.transactions).toBe(7);
    expect(totals.expense).toBeCloseTo(391.35, 2);
    expect(totals.income).toBeCloseTo(2500, 2);
    expect(budgetAmount).toBeNull();
  });

  it('with period=all sums every date', async () => {
    const { totals } = await summary({ period: 'all' });
    expect(totals.transactions).toBe(8);
    expect(totals.expense).toBeCloseTo(398.35, 2);
  });

  it('from+to is inclusive and overrides period', async () => {
    const { totals } = await summary({
      period: '2026-03',
      from: '2026-01-31',
      to: '2026-02-01',
    });
    expect(totals.transactions).toBe(2);
    expect(totals.expense).toBeCloseTo(230.2, 2);
  });

  it('breaks expenses down by category with the fixed monthly budget', async () => {
    const { categories } = await summary({ period: '2026-01' });
    const food = categories.find((c) => c.name === 'Food');
    const rent = categories.find((c) => c.name === 'Rent');
    expect(categories).toHaveLength(2);
    expect(food.amount).toBeCloseTo(300.3, 2);
    expect(food.monthlyBudget).toBe(300);
    expect(rent.amount).toBeCloseTo(50.05, 2);
    expect(rent.monthlyBudget).toBeNull();
  });

  it('breaks income down by category and method', async () => {
    const { incomeCategories, incomeMethods } = await summary({
      period: '2026',
    });
    expect(incomeCategories).toHaveLength(1);
    expect(incomeCategories[0].amount).toBeCloseTo(2500, 2);
    expect(incomeMethods.account).toBeCloseTo(2000, 2);
    expect(incomeMethods.cash).toBeCloseTo(500, 2);
  });

  it('splits expenses by payment method and card', async () => {
    const { paymentMethods, perCard } = await summary({ period: '2026-01' });
    expect(paymentMethods.cash).toBeCloseTo(100.1, 2);
    expect(paymentMethods.card).toBeCloseTo(200.2, 2);
    expect(paymentMethods.account).toBeCloseTo(50.05, 2);
    expect(perCard.Visa).toBeCloseTo(200.2, 2);
  });

  it('returns a daily series in date order', async () => {
    const { incomeVsExpense } = await summary({ period: '2026-01' });
    expect(incomeVsExpense.map((d) => d.date)).toEqual([
      '2026-01-01',
      '2026-01-10',
      '2026-01-20',
      '2026-01-31',
    ]);
    expect(incomeVsExpense[0].income).toBeCloseTo(2000, 2);
    expect(incomeVsExpense[3].expense).toBeCloseTo(200.2, 2);
  });

  it('returns the budget of the selected month only', async () => {
    const january = await summary({ period: '2026-01' });
    const february = await summary({ period: '2026-02' });
    expect(Number(january.budgetAmount)).toBe(1500);
    expect(february.budgetAmount).toBeNull();
  });
});
