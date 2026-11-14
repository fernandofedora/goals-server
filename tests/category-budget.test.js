import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app.js';
import { Transaction } from '../src/models/index.js';
import { createAccount, createCategory, createUser } from './helpers.js';

let user;
let auth;
let home;
let light;
let food;

const spend = (amount, date, category, extra = {}) =>
  Transaction.create({
    description: 'Gasto',
    type: 'expense',
    amount,
    date,
    paymentMethod: 'cash',
    CategoryId: category.id,
    UserId: user.id,
    ...extra,
  });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-03-10T12:00:00'));
  ({ user, auth } = await createUser());
  home = await createCategory(user, 'Hogar');
  light = await createCategory(user, 'Luz', 'expense', {
    parentId: home.id,
    monthlyBudget: 60,
  });
  await createCategory(user, 'Agua', 'expense', {
    parentId: home.id,
    monthlyBudget: 40,
  });
  food = await createCategory(user, 'Comida', 'expense', {
    monthlyBudget: 200,
  });
  await createCategory(user, 'Sin presupuesto');
  await spend(30, '2026-03-02', light);
  await spend(20, '2026-03-05', home);
  await spend(50, '2026-03-05', food);
  await spend(80, '2026-02-03', food);
  await spend(40, '2026-02-28', food);
});
afterEach(() => vi.useRealTimers());

describe('GET /api/stats/category-budgets', () => {
  it('lists categories with a budget, parents summing their children', async () => {
    const res = await request(app)
      .get('/api/stats/category-budgets')
      .query({ period: '2026-03' })
      .set(auth);
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(res.body.items.map((i) => [i.name, i]));
    expect(Object.keys(byName).sort()).toEqual(['Comida', 'Hogar']);
    expect(byName.Hogar).toMatchObject({ budget: 100, spent: 50 });
    expect(
      byName.Hogar.children.map((c) => [c.name, c.budget, c.spent]),
    ).toEqual(
      expect.arrayContaining([
        ['Luz', 60, 30],
        ['Agua', 40, 0],
      ]),
    );
    expect(byName.Comida).toMatchObject({ budget: 200, spent: 50 });
  });

  it('leaves out isolated accounts and rejects a bad period', async () => {
    const isolated = await createAccount(user, 'Aparte', {
      isExcludedFromTotals: true,
    });
    await spend(500, '2026-03-06', food, {
      AccountId: isolated.id,
      paymentMethod: 'account',
    });
    const res = await request(app)
      .get('/api/stats/category-budgets')
      .query({ period: '2026-03' })
      .set(auth);
    expect(res.body.items.find((i) => i.name === 'Comida').spent).toBe(50);
    const bad = await request(app)
      .get('/api/stats/category-budgets')
      .query({ period: '2026-13' })
      .set(auth);
    expect(bad.status).toBe(400);
  });
});

describe('GET /api/stats/category-budget/:id', () => {
  it('returns cumulative daily spending next to the previous month', async () => {
    const res = await request(app)
      .get(`/api/stats/category-budget/${food.id}`)
      .query({ period: '2026-03' })
      .set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      budget: 200,
      spent: 50,
      previousSpent: 120,
      previousPeriod: '2026-02',
    });
    const day = (n) => res.body.series[n - 1];
    expect(res.body.series).toHaveLength(31);
    expect(day(4)).toEqual({ day: 4, spent: 0, previous: 80 });
    expect(day(5)).toMatchObject({ spent: 50 });
    // Today is the 10th: later days have no spending line yet.
    expect(day(10).spent).toBe(50);
    expect(day(11).spent).toBeNull();
    // February has 28 days; March 29-31 keep February's total.
    expect(day(31).previous).toBe(120);
  });

  it('includes subcategories for a parent and uses their summed budget', async () => {
    const res = await request(app)
      .get(`/api/stats/category-budget/${home.id}`)
      .query({ period: '2026-03' })
      .set(auth);
    expect(res.body).toMatchObject({ budget: 100, spent: 50 });
    const child = await request(app)
      .get(`/api/stats/category-budget/${light.id}`)
      .query({ period: '2026-03' })
      .set(auth);
    expect(child.body).toMatchObject({ budget: 60, spent: 30 });
  });

  it('is not found for another user or an income category', async () => {
    const other = await createUser();
    const res = await request(app)
      .get(`/api/stats/category-budget/${food.id}`)
      .set(other.auth);
    expect(res.status).toBe(404);
    const salary = await createCategory(user, 'Salario', 'income');
    const income = await request(app)
      .get(`/api/stats/category-budget/${salary.id}`)
      .set(auth);
    expect(income.status).toBe(404);
  });
});
