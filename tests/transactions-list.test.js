import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { Transaction } from '../src/models/index.js';
import {
  createAccount,
  createCard,
  createCategory,
  createUser,
} from './helpers.js';

let auth;
let user;
let food;
let salary;
let card;
let bank;

const list = async (query) => {
  const res = await request(app)
    .get('/api/transactions')
    .query({ page: 1, limit: 50, ...query })
    .set(auth);
  expect(res.status).toBe(200);
  return res.body;
};
const names = (body) => body.items.map((t) => t.description).sort();

beforeAll(async () => {
  ({ user, auth } = await createUser());
  food = await createCategory(user, 'Comida');
  salary = await createCategory(user, 'Salario', 'income');
  card = await createCard(user);
  bank = await createAccount(user);
  const tx = (description, type, amount, date, paymentMethod, extra = {}) => ({
    description,
    type,
    amount,
    date,
    paymentMethod,
    UserId: user.id,
    ...extra,
  });
  await Transaction.bulkCreate([
    tx('Supermercado', 'expense', 80, '2026-03-10', 'cash', {
      CategoryId: food.id,
    }),
    tx('Restaurante', 'expense', 40.5, '2026-03-10', 'card', {
      CategoryId: food.id,
      CardId: card.id,
    }),
    tx('Descuento 50% tienda', 'expense', 15, '2026-03-05', 'cash'),
    tx('Sueldo marzo', 'income', 1000, '2026-03-01', 'account', {
      CategoryId: salary.id,
      AccountId: bank.id,
    }),
    tx('Sueldo febrero', 'income', 900, '2026-02-01', 'account', {
      CategoryId: salary.id,
      AccountId: bank.id,
    }),
  ]);
});

describe('GET /api/transactions filters', () => {
  it.each([
    [{ q: 'sueldo' }, ['Sueldo febrero', 'Sueldo marzo']],
    [{ type: 'income' }, ['Sueldo febrero', 'Sueldo marzo']],
    [{ paymentMethod: 'card' }, ['Restaurante']],
    [{ from: '2026-03-05', to: '2026-03-05' }, ['Descuento 50% tienda']],
    [{ from: '2026-03-10' }, ['Restaurante', 'Supermercado']],
    [{ to: '2026-02-28' }, ['Sueldo febrero']],
    [{ minAmount: 900 }, ['Sueldo febrero', 'Sueldo marzo']],
    [{ maxAmount: 15 }, ['Descuento 50% tienda']],
    [{ minAmount: 40.5, maxAmount: 80 }, ['Restaurante', 'Supermercado']],
  ])('applies %j', async (query, expected) => {
    expect(names(await list(query))).toEqual(expected);
  });

  it('filters by category, account and card ids', async () => {
    expect(names(await list({ categoryId: food.id }))).toEqual([
      'Restaurante',
      'Supermercado',
    ]);
    expect(names(await list({ cardId: card.id }))).toEqual(['Restaurante']);
    expect((await list({ accountId: bank.id })).total).toBe(2);
  });

  it('combines filters', async () => {
    const body = await list({
      type: 'expense',
      paymentMethod: 'cash',
      minAmount: 20,
    });
    expect(names(body)).toEqual(['Supermercado']);
  });

  it('treats % in the search as text', async () => {
    expect(names(await list({ q: '50%' }))).toEqual(['Descuento 50% tienda']);
    expect((await list({ q: '%' })).total).toBe(1);
  });

  it.each([
    [{ type: 'other' }],
    [{ paymentMethod: 'crypto' }],
    [{ from: 'ayer' }],
    [{ minAmount: 'mucho' }],
  ])('rejects %j', async (query) => {
    const res = await request(app)
      .get('/api/transactions')
      .query(query)
      .set(auth);
    expect(res.status).toBe(400);
  });

  it('totals cover every filtered row, not just the page', async () => {
    const body = await list({ limit: 1 });
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(5);
    expect(body.totals.income).toBe(1900);
    expect(body.totals.expense).toBe(135.5);
  });

  it('day totals include rows that fall on another page', async () => {
    const body = await list({ from: '2026-03-10', limit: 1 });
    expect(body.items).toHaveLength(1);
    expect(body.dayTotals).toEqual({ '2026-03-10': -120.5 });
  });

  it('never repeats a row across pages on the same day', async () => {
    const first = await list({ from: '2026-03-10', limit: 1, page: 1 });
    const second = await list({ from: '2026-03-10', limit: 1, page: 2 });
    expect(first.items[0].id).not.toBe(second.items[0].id);
  });

  it('keeps returning a plain array without pagination', async () => {
    const res = await request(app)
      .get('/api/transactions')
      .query({ type: 'income' })
      .set(auth);
    expect(res.body).toHaveLength(2);
  });
});

describe('bulk actions', () => {
  const seed = async (owner, category, type = 'expense') => {
    const row = await Transaction.create({
      description: 'x',
      type,
      amount: 1,
      date: '2026-01-01',
      paymentMethod: 'cash',
      UserId: owner.id,
      CategoryId: category?.id ?? null,
    });
    return row.id;
  };

  it('changes the category of the selected rows', async () => {
    const owner = await createUser();
    const a = await createCategory(owner.user, 'A');
    const b = await createCategory(owner.user, 'B');
    const ids = [await seed(owner.user, a), await seed(owner.user, a)];

    const res = await request(app)
      .patch('/api/transactions/bulk')
      .set(owner.auth)
      .send({ ids, categoryId: b.id });

    expect(res.body).toEqual({ updated: 2, skipped: 0 });
    const rows = await Transaction.findAll({ where: { id: ids } });
    expect(rows.every((r) => r.CategoryId === b.id)).toBe(true);
  });

  it('skips rows whose type does not match the category', async () => {
    const owner = await createUser();
    const expenseCat = await createCategory(owner.user, 'Gasto');
    const income = await seed(owner.user, null, 'income');
    const expense = await seed(owner.user, null);

    const res = await request(app)
      .patch('/api/transactions/bulk')
      .set(owner.auth)
      .send({ ids: [income, expense], categoryId: expenseCat.id });

    expect(res.body).toEqual({ updated: 1, skipped: 1 });
    expect((await Transaction.findByPk(income)).CategoryId).toBeNull();
  });

  it("never touches another user's rows or uses their category", async () => {
    const owner = await createUser();
    const intruder = await createUser();
    const ownerCat = await createCategory(owner.user, 'Dueño');
    const intruderCat = await createCategory(intruder.user, 'Intruso');
    const id = await seed(owner.user, ownerCat);

    const update = await request(app)
      .patch('/api/transactions/bulk')
      .set(intruder.auth)
      .send({ ids: [id], categoryId: intruderCat.id });
    const foreignCategory = await request(app)
      .patch('/api/transactions/bulk')
      .set(owner.auth)
      .send({ ids: [id], categoryId: intruderCat.id });
    const remove = await request(app)
      .post('/api/transactions/bulk-delete')
      .set(intruder.auth)
      .send({ ids: [id] });

    expect(update.body.updated).toBe(0);
    expect(foreignCategory.status).toBe(404);
    expect(remove.body.deleted).toBe(0);
    expect((await Transaction.findByPk(id)).CategoryId).toBe(ownerCat.id);
  });

  it('deletes the selected rows', async () => {
    const owner = await createUser();
    const keep = await seed(owner.user);
    const gone = await seed(owner.user);

    const res = await request(app)
      .post('/api/transactions/bulk-delete')
      .set(owner.auth)
      .send({ ids: [gone] });

    expect(res.body.deleted).toBe(1);
    expect(await Transaction.findByPk(gone)).toBeNull();
    expect(await Transaction.findByPk(keep)).not.toBeNull();
  });

  it.each([[[]], ['1'], [[1, 'a']], [Array(501).fill(1)]])(
    'rejects invalid ids %#',
    async (ids) => {
      const owner = await createUser();
      const res = await request(app)
        .post('/api/transactions/bulk-delete')
        .set(owner.auth)
        .send({ ids });
      expect(res.status).toBe(400);
    },
  );
});
