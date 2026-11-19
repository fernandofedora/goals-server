import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { Tag, Transaction } from '../src/models/index.js';
import { createAccount, createCategory, createUser } from './helpers.js';

let user;
let auth;
let food;
let health;
let salary;
let bank;
let tx;

const split = (id, parts) =>
  request(app).put(`/api/transactions/${id}/split`).set(auth).send({ parts });
const summary = () =>
  request(app).get('/api/stats/summary').query({ period: '2026-03' }).set(auth);

beforeEach(async () => {
  ({ user, auth } = await createUser());
  food = await createCategory(user, 'Comida', 'expense', {
    monthlyBudget: 100,
  });
  health = await createCategory(user, 'Salud');
  salary = await createCategory(user, 'Salario', 'income');
  bank = await createAccount(user, 'Banco', { initialBalance: 500 });
  tx = await Transaction.create({
    description: 'Súper y farmacia',
    type: 'expense',
    amount: 80,
    date: '2026-03-10',
    paymentMethod: 'account',
    AccountId: bank.id,
    CategoryId: food.id,
    UserId: user.id,
  });
});

describe('splitting a transaction', () => {
  it('keeps totals and balances, and moves the spending to each category', async () => {
    const before = (await summary()).body;
    const res = await split(tx.id, [
      { amount: 55.5, categoryId: food.id },
      { amount: 24.5, categoryId: health.id, description: 'Farmacia' },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.original).toMatchObject({
      id: tx.id,
      amount: 80,
      isSplit: true,
    });
    expect(
      res.body.parts.map((p) => [
        p.description,
        Number(p.amount),
        p.Category.name,
      ]),
    ).toEqual([
      ['Súper y farmacia', 55.5, 'Comida'],
      ['Farmacia', 24.5, 'Salud'],
    ]);

    const after = (await summary()).body;
    // Same money; the split just shows two movements instead of one.
    const money = ({ income, expense, balance }) => ({ income, expense, balance });
    expect(money(after.totals)).toEqual(money(before.totals));
    expect(after.totals.transactions).toBe(before.totals.transactions + 1);
    const amountOf = (name) =>
      after.categories.find((c) => c.name === name)?.amount;
    expect(amountOf('Comida')).toBe(55.5);
    expect(amountOf('Salud')).toBe(24.5);

    const history = await request(app).get('/api/accounts/history').set(auth);
    expect(history.body.find((a) => a.accountId === bank.id).balance).toBe(420);
    const list = await request(app)
      .get('/api/transactions')
      .query({ page: 1, limit: 10 })
      .set(auth);
    expect(list.body.total).toBe(2);
    expect(list.body.items.every((t) => t.splitOfId === tx.id)).toBe(true);
    const budget = await request(app)
      .get(`/api/stats/category-budget/${food.id}`)
      .query({ period: '2026-03' })
      .set(auth);
    expect(budget.body.spent).toBe(55.5);
  });

  it('refuses parts that do not add up or do not fit', async () => {
    expect(
      (await split(tx.id, [{ amount: 80, categoryId: food.id }])).body.code,
    ).toBe('SPLIT_PART_COUNT');
    const off = await split(tx.id, [
      { amount: 50, categoryId: food.id },
      { amount: 20, categoryId: health.id },
    ]);
    expect(off.body).toMatchObject({ code: 'SPLIT_SUM_MISMATCH', total: 70 });
    expect(
      (
        await split(tx.id, [
          { amount: 79.999, categoryId: food.id },
          { amount: 0.001, categoryId: food.id },
        ])
      ).body.code,
    ).toBe('SPLIT_PART_AMOUNT');
    expect(
      (
        await split(tx.id, [
          { amount: 40, categoryId: food.id },
          { amount: 40, categoryId: salary.id },
        ])
      ).body.code,
    ).toBe('SPLIT_PART_CATEGORY');
    const other = await createUser();
    const foreign = await createCategory(other.user, 'Ajena');
    expect(
      (
        await split(tx.id, [
          { amount: 40, categoryId: food.id },
          { amount: 40, categoryId: foreign.id },
        ])
      ).body.code,
    ).toBe('SPLIT_PART_CATEGORY');
    expect(
      (
        await request(app)
          .put(`/api/transactions/${tx.id}/split`)
          .set(other.auth)
          .send({ parts: [] })
      ).status,
    ).toBe(404);
    expect(await Transaction.count({ where: { splitOfId: tx.id } })).toBe(0);
  });

  it('re-splits from a part, and joins back with the first category and all tags', async () => {
    const trip = await Tag.create({ name: 'Viaje', UserId: user.id });
    await tx.setTags([trip]);
    const first = await split(tx.id, [
      { amount: 60, categoryId: food.id },
      { amount: 20, categoryId: health.id },
    ]);
    expect(
      first.body.parts.every(
        (p) => p.Tags.map((tag) => tag.name).join() === 'Viaje',
      ),
    ).toBe(true);

    const partId = first.body.parts[1].id;
    const again = await split(partId, [
      { amount: 30, categoryId: food.id },
      { amount: 30, categoryId: food.id },
      { amount: 20, categoryId: health.id },
    ]);
    expect(again.body.parts).toHaveLength(3);
    expect(await Transaction.count({ where: { splitOfId: tx.id } })).toBe(3);

    const joined = await request(app)
      .delete(`/api/transactions/${tx.id}/split`)
      .set(auth);
    expect(joined.body.original).toMatchObject({ isSplit: false, amount: 80 });
    const restored = await Transaction.findByPk(tx.id, { include: [Tag] });
    expect(restored).toMatchObject({
      CategoryId: food.id,
      isSplitContainer: false,
    });
    expect(restored.Tags.map((tag) => tag.name)).toEqual(['Viaje']);
    expect(await Transaction.count({ where: { splitOfId: tx.id } })).toBe(0);
  });

  it('locks what keeps the parts adding up, but lets the category change', async () => {
    const { body } = await split(tx.id, [
      { amount: 60, categoryId: food.id },
      { amount: 20, categoryId: health.id },
    ]);
    const part = body.parts[0];
    const base = {
      type: 'expense',
      description: part.description,
      amount: 60,
      date: '2026-03-10',
      paymentMethod: 'account',
      accountId: bank.id,
      categoryId: food.id,
    };
    const put = (patch) =>
      request(app)
        .put(`/api/transactions/${part.id}`)
        .set(auth)
        .send({ ...base, ...patch });
    expect((await put({ amount: 61 })).body.code).toBe('SPLIT_PART_LOCKED');
    expect((await put({ date: '2026-03-11' })).body.code).toBe(
      'SPLIT_PART_LOCKED',
    );
    expect(
      (await put({ paymentMethod: 'cash', accountId: null })).body.code,
    ).toBe('SPLIT_PART_LOCKED');
    const ok = await put({ categoryId: health.id, description: 'Otra cosa' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      CategoryId: health.id,
      description: 'Otra cosa',
    });
  });

  it('deletes the whole purchase when one part is deleted, alone or in bulk', async () => {
    const { body } = await split(tx.id, [
      { amount: 60, categoryId: food.id },
      { amount: 20, categoryId: health.id },
    ]);
    const res = await request(app)
      .delete(`/api/transactions/${body.parts[0].id}`)
      .set(auth);
    expect(res.body.deleted).toBe(2);
    expect(
      await Transaction.unscoped().count({ where: { UserId: user.id } }),
    ).toBe(0);

    const other = await Transaction.create({
      description: 'Otra',
      type: 'expense',
      amount: 10,
      date: '2026-03-11',
      paymentMethod: 'cash',
      UserId: user.id,
      CategoryId: food.id,
    });
    const bulk = await split(other.id, [
      { amount: 5, categoryId: food.id },
      { amount: 5, categoryId: health.id },
    ]);
    const del = await request(app)
      .post('/api/transactions/bulk-delete')
      .set(auth)
      .send({ ids: [bulk.body.parts[1].id] });
    expect(del.body.deleted).toBe(2);
    expect(
      await Transaction.unscoped().count({ where: { UserId: user.id } }),
    ).toBe(0);
  });

  it('never shows the container in the inbox and keeps import duplicates working', async () => {
    await split(tx.id, [
      { amount: 60, categoryId: food.id },
      { amount: 20, categoryId: health.id },
    ]);
    const inbox = await request(app)
      .get('/api/transactions/uncategorized')
      .set(auth);
    expect(inbox.body.count).toBe(0);

    // Re-importing the bank line of the original is still a duplicate.
    const csv = Buffer.from(
      'Fecha,Descripción,Monto,Tipo,Categoría\r\n2026-03-10,Súper y farmacia,80,Gasto,\r\n',
      'utf8',
    );
    await user.update({ language: 'es' });
    const preview = await request(app)
      .post('/api/import/preview')
      .set(auth)
      .field('target', `account:${bank.id}`)
      .attach('file', csv, { filename: 'a.csv', contentType: 'text/csv' });
    expect(preview.body.summary).toEqual({ ok: 0, duplicate: 1, error: 0 });
  });
});
