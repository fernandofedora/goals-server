import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app.js';
import {
  Category,
  SpendingBudget,
  Tag,
  Transaction,
} from '../src/models/index.js';
import {
  budgetStatuses,
  migrateCategoryBudgets,
} from '../src/services/spendingBudgets.js';
import {
  nextPeriod,
  periodFor,
  previousPeriod,
} from '../src/utils/budgetPeriod.js';
import {
  createAccount,
  createBudget,
  createCategory,
  createUser,
} from './helpers.js';

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
const post = (body, as = auth) =>
  request(app).post('/api/spending-budgets').set(as).send(body);
const statusOf = async (id) =>
  (await request(app).get('/api/spending-budgets').set(auth)).body.find(
    (b) => b.id === id,
  );

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-03-10T12:00:00'));
  ({ user, auth } = await createUser());
  home = await createCategory(user, 'Hogar');
  light = await createCategory(user, 'Luz', 'expense', { parentId: home.id });
  food = await createCategory(user, 'Comida');
});
afterEach(() => vi.useRealTimers());

describe('budget periods', () => {
  it('weekly periods start on the chosen weekday', () => {
    // 2026-03-10 is a Tuesday.
    expect(periodFor('weekly', 1, '2026-03-10')).toEqual({
      start: '2026-03-09',
      end: '2026-03-15',
    });
    expect(periodFor('weekly', 5, '2026-03-10')).toEqual({
      start: '2026-03-06',
      end: '2026-03-12',
    });
  });

  it('monthly periods snap a missing start day to the month end', () => {
    expect(periodFor('monthly', 15, '2026-03-10')).toEqual({
      start: '2026-02-15',
      end: '2026-03-14',
    });
    const feb = periodFor('monthly', 31, '2026-02-28');
    expect(feb).toEqual({ start: '2026-02-28', end: '2026-03-30' });
    expect(nextPeriod('monthly', 31, feb)).toEqual({
      start: '2026-03-31',
      end: '2026-04-29',
    });
    expect(previousPeriod('monthly', 31, feb)).toEqual({
      start: '2026-01-31',
      end: '2026-02-27',
    });
  });

  it('quarters run from January, April, July and October', () => {
    expect(periodFor('quarterly', 1, '2026-05-20')).toEqual({
      start: '2026-04-01',
      end: '2026-06-30',
    });
    expect(periodFor('quarterly', 15, '2026-04-10')).toEqual({
      start: '2026-01-15',
      end: '2026-04-14',
    });
  });
});

describe('budget statuses', () => {
  it('a category brings its subcategories; tags count too', async () => {
    const trip = await Tag.create({ name: 'Viaje', UserId: user.id });
    const b = await createBudget(
      user,
      { name: 'Casa y viajes', amount: 200 },
      { categories: [home], tags: [trip] },
    );
    await spend(30, '2026-03-02', light);
    await spend(20, '2026-03-05', home);
    const tagged = await spend(15, '2026-03-06', food);
    await tagged.setTags([trip]);
    await spend(50, '2026-03-06', food);
    await spend(99, '2026-02-27', home);
    const status = await statusOf(b.id);
    expect(status).toMatchObject({
      spent: 65,
      available: 200,
      remaining: 135,
      percent: 32.5,
      period: { start: '2026-03-01', end: '2026-03-31' },
    });
    expect(status.tags.map((t) => t.name)).toEqual(['Viaje']);
  });

  it('the catch-all takes only what no other budget covers', async () => {
    await createBudget(user, { name: 'Hogar' }, { categories: [home] });
    const rest = await createBudget(user, {
      name: 'General',
      amount: 500,
      isCatchAll: true,
    });
    await spend(30, '2026-03-02', light);
    await spend(50, '2026-03-06', food);
    const salary = await createCategory(user, 'Transfer', 'transfer');
    await spend(400, '2026-03-06', salary);
    expect((await statusOf(rest.id)).spent).toBe(50);
  });

  it('leaves out isolated accounts', async () => {
    const b = await createBudget(user, {}, { categories: [food] });
    const isolated = await createAccount(user, 'Aparte', {
      isExcludedFromTotals: true,
    });
    await spend(500, '2026-03-06', food, {
      AccountId: isolated.id,
      paymentMethod: 'account',
    });
    await spend(10, '2026-03-06', food);
    expect((await statusOf(b.id)).spent).toBe(10);
  });

  it('rollover carries both the leftover and the overspending', async () => {
    vi.setSystemTime(new Date('2026-01-05T12:00:00'));
    const b = await createBudget(
      user,
      { amount: 100, rollover: true },
      { categories: [food] },
    );
    const plain = await createBudget(
      user,
      { amount: 100 },
      { categories: [food] },
    );
    await spend(60, '2026-01-10', food); // 40 left
    await spend(130, '2026-02-10', food); // 30 over
    await spend(20, '2026-03-03', food);
    vi.setSystemTime(new Date('2026-03-10T12:00:00'));
    expect(await statusOf(b.id)).toMatchObject({
      carry: 10,
      available: 110,
      spent: 20,
      remaining: 90,
    });
    expect(await statusOf(plain.id)).toMatchObject({
      carry: 0,
      available: 100,
    });
  });

  it('a budget fully spent with nothing available reads 100%', async () => {
    vi.setSystemTime(new Date('2026-02-01T12:00:00'));
    const b = await createBudget(
      user,
      { amount: 50, rollover: true },
      { categories: [food] },
    );
    await spend(160, '2026-02-10', food);
    await spend(5, '2026-03-02', food);
    vi.setSystemTime(new Date('2026-03-10T12:00:00'));
    const [status] = await budgetStatuses(user.id);
    expect(status.id).toBe(b.id);
    expect(status).toMatchObject({ available: -60, percent: 100 });
  });
});

describe('budget API', () => {
  it('creates, edits and deletes a budget', async () => {
    const trip = await Tag.create({ name: 'Viaje', UserId: user.id });
    const res = await post({
      name: '  Casa  ',
      amount: 250.5,
      periodType: 'weekly',
      startDay: 1,
      categoryIds: [home.id],
      tagIds: [trip.id],
      rollover: true,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: 'Casa',
      periodType: 'weekly',
      rollover: true,
      categoryIds: [home.id],
      tagIds: [trip.id],
    });

    const edit = await request(app)
      .put(`/api/spending-budgets/${res.body.id}`)
      .set(auth)
      .send({ periodType: 'quarterly', startDay: 15, tagIds: [] });
    expect(edit.body).toMatchObject({
      name: 'Casa',
      periodType: 'quarterly',
      startDay: 15,
      categoryIds: [home.id],
      tagIds: [],
    });

    const del = await request(app)
      .delete(`/api/spending-budgets/${res.body.id}`)
      .set(auth);
    expect(del.body.success).toBe(true);
    expect(await SpendingBudget.count({ where: { UserId: user.id } })).toBe(0);
  });

  it('rejects bad input', async () => {
    const salary = await createCategory(user, 'Salario', 'income');
    const other = await createUser();
    const otherCat = await createCategory(other.user, 'Ajena');
    const base = { name: 'X', amount: 10, categoryIds: [food.id] };
    const code = async (body) => (await post({ ...base, ...body })).body.code;

    expect(await code({ name: '   ' })).toBe('BUDGET_INVALID_NAME');
    expect(await code({ name: 'x'.repeat(61) })).toBe('BUDGET_INVALID_NAME');
    expect(await code({ amount: 0 })).toBe('BUDGET_INVALID_AMOUNT');
    expect(await code({ amount: 10.001 })).toBe('BUDGET_INVALID_AMOUNT');
    expect(await code({ amount: '1e12' })).toBe('BUDGET_INVALID_AMOUNT');
    expect(await code({ periodType: 'daily' })).toBe('BUDGET_INVALID_PERIOD');
    expect(await code({ periodType: 'weekly', startDay: 8 })).toBe(
      'BUDGET_INVALID_START',
    );
    expect(await code({ startDay: 0 })).toBe('BUDGET_INVALID_START');
    expect(await code({ categoryIds: ['1 OR 1=1'] })).toBe(
      'BUDGET_INVALID_SCOPE',
    );
    expect(await code({ categoryIds: [salary.id] })).toBe(
      'BUDGET_INVALID_SCOPE',
    );
    expect(await code({ categoryIds: [otherCat.id] })).toBe(
      'BUDGET_INVALID_SCOPE',
    );
    expect(await code({ categoryIds: [] })).toBe('BUDGET_EMPTY_SCOPE');
    expect(await code({ isCatchAll: true })).toBe('BUDGET_CATCHALL_SCOPE');
    expect(await code({ isCatchAll: true, categoryIds: [] })).toBeUndefined();
    expect(await code({ isCatchAll: true, categoryIds: [] })).toBe(
      'BUDGET_CATCHALL_TAKEN',
    );
  });

  it('keeps budgets private to their owner', async () => {
    const b = await createBudget(user, {}, { categories: [food] });
    const other = await createUser();
    for (const req of [
      request(app).put(`/api/spending-budgets/${b.id}`).send({ amount: 1 }),
      request(app).delete(`/api/spending-budgets/${b.id}`),
      request(app).get(`/api/spending-budgets/${b.id}/detail`),
    ]) {
      expect((await req.set(other.auth)).status).toBe(404);
    }
    expect(
      (await request(app).get('/api/spending-budgets').set(other.auth)).body,
    ).toEqual([]);
  });

  it('the detail compares day by day with the period before', async () => {
    const b = await createBudget(user, {}, { categories: [food] });
    await spend(30, '2026-03-02', food);
    await spend(20, '2026-03-05', food);
    await spend(80, '2026-02-03', food);
    const res = await request(app)
      .get(`/api/spending-budgets/${b.id}/detail`)
      .set(auth);
    expect(res.status).toBe(200);
    expect(res.body.series).toHaveLength(31);
    expect(res.body.series[1]).toMatchObject({
      day: 2,
      spent: 30,
      previous: 0,
    });
    expect(res.body.series[4]).toMatchObject({ spent: 50, previous: 80 });
    // Days still to come have no spending yet.
    expect(res.body.series[20].spent).toBeNull();
    expect(res.body.previousPeriod).toMatchObject({
      start: '2026-02-01',
      spent: 80,
    });
    expect(res.body.transactions.map((t) => t.amount)).toEqual([20, 30]);

    const past = await request(app)
      .get(`/api/spending-budgets/${b.id}/detail`)
      .query({ offset: -1 })
      .set(auth);
    expect(past.body.budget).toMatchObject({
      spent: 80,
      period: { start: '2026-02-01', end: '2026-02-28' },
    });
    for (const offset of [1, 'abc', -61]) {
      const bad = await request(app)
        .get(`/api/spending-budgets/${b.id}/detail`)
        .query({ offset })
        .set(auth);
      expect(bad.status).toBe(400);
    }
  });
});

describe('migrateCategoryBudgets', () => {
  it('moves each category budget into a monthly budget, once', async () => {
    await food.update({ monthlyBudget: 200 });
    await light.update({ monthlyBudget: 0 });
    await migrateCategoryBudgets();
    const budgets = await SpendingBudget.findAll({
      where: { UserId: user.id },
      include: [Category],
    });
    expect(budgets).toHaveLength(1);
    expect(budgets[0]).toMatchObject({
      name: 'Comida',
      periodType: 'monthly',
      startDay: 1,
      rollover: false,
      migratedFromCategoryId: food.id,
    });
    expect(Number(budgets[0].amount)).toBe(200);
    expect(budgets[0].Categories.map((c) => c.id)).toEqual([food.id]);
    expect((await food.reload()).monthlyBudget).toBeNull();
    expect((await light.reload()).monthlyBudget).toBeNull();

    await migrateCategoryBudgets();
    expect(await SpendingBudget.count({ where: { UserId: user.id } })).toBe(1);
  });

  it('categories no longer take a budget through the API', async () => {
    const res = await request(app)
      .post('/api/categories')
      .set(auth)
      .send({ name: 'Ocio', type: 'expense', monthlyBudget: 90 });
    expect(res.body.monthlyBudget ?? null).toBeNull();
  });
});
