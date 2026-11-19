import request from 'supertest';
import ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app.js';
import { Tag, Transaction, TransactionTag } from '../src/models/index.js';
import { createAccount, createCategory, createUser } from './helpers.js';

let user;
let auth;
let food;

const createTag = (name, color = '#2563eb', as = auth) =>
  request(app).post('/api/tags').set(as).send({ name, color });
const createTx = (body) =>
  request(app)
    .post('/api/transactions')
    .set(auth)
    .send({
      type: 'expense',
      description: 'Gasto',
      amount: 10,
      date: '2026-03-10',
      paymentMethod: 'cash',
      categoryId: food.id,
      ...body,
    });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-03-20T12:00:00'));
  ({ user, auth } = await createUser());
  food = await createCategory(user, 'Comida');
});
afterEach(() => vi.useRealTimers());

describe('tags API', () => {
  it('validates names and refuses duplicates ignoring case and accents', async () => {
    expect((await createTag('')).body.code).toBe('TAG_INVALID_NAME');
    expect((await createTag('x'.repeat(41))).body.code).toBe(
      'TAG_INVALID_NAME',
    );
    expect((await createTag('viaje, playa')).body.code).toBe(
      'TAG_INVALID_NAME',
    );
    expect((await createTag('Viaje', 'rojo')).body.code).toBe(
      'TAG_INVALID_COLOR',
    );
    const ok = await createTag('Viaje Perú');
    expect(ok.body).toMatchObject({
      name: 'Viaje Perú',
      color: '#2563eb',
      count: 0,
    });
    expect((await createTag('viaje peru')).body.code).toBe('TAG_DUPLICATE');
    // Another user can use the same name.
    const other = await createUser();
    expect((await createTag('Viaje Perú', '#2563eb', other.auth)).status).toBe(
      200,
    );
  });

  it('tags transactions, lists them with their tags and filters by tag', async () => {
    const trip = (await createTag('Viaje')).body;
    const work = (await createTag('Trabajo')).body;
    const a = await createTx({
      description: 'Hotel',
      tagIds: [trip.id, work.id],
    });
    expect(a.body.Tags.map((t) => t.name).sort()).toEqual(['Trabajo', 'Viaje']);
    await createTx({ description: 'Taxi', tagIds: [trip.id] });
    await createTx({ description: 'Súper' });

    const list = await request(app)
      .get('/api/transactions')
      .query({ page: 1, limit: 10 })
      .set(auth);
    // Two tags on one transaction must not count it twice.
    expect(list.body.total).toBe(3);
    expect(list.body.items).toHaveLength(3);

    const filtered = await request(app)
      .get('/api/transactions')
      .query({ page: 1, limit: 10, tagId: trip.id })
      .set(auth);
    expect(filtered.body.items.map((t) => t.description).sort()).toEqual([
      'Hotel',
      'Taxi',
    ]);
    expect(filtered.body.totals.expense).toBe(20);

    const tags = (await request(app).get('/api/tags').set(auth)).body;
    expect(tags.find((t) => t.name === 'Viaje').count).toBe(2);
  });

  it('keeps tags on an edit that does not send them and clears them with []', async () => {
    const trip = (await createTag('Viaje')).body;
    const tx = (await createTx({ tagIds: [trip.id] })).body;
    const base = {
      type: 'expense',
      description: 'Hotel caro',
      amount: 99,
      date: '2026-03-10',
      paymentMethod: 'cash',
      categoryId: food.id,
    };
    const kept = await request(app)
      .put(`/api/transactions/${tx.id}`)
      .set(auth)
      .send(base);
    expect(kept.body.Tags).toHaveLength(1);
    const cleared = await request(app)
      .put(`/api/transactions/${tx.id}`)
      .set(auth)
      .send({ ...base, tagIds: [] });
    expect(cleared.body.Tags).toHaveLength(0);
  });

  it('refuses tags of another user and too many tags', async () => {
    const other = await createUser();
    const foreign = (await createTag('Ajena', '#000000', other.auth)).body;
    expect((await createTx({ tagIds: [foreign.id] })).body.code).toBe(
      'TAGS_INVALID',
    );
    expect((await createTx({ tagIds: 'DROP' })).body.code).toBe('TAGS_INVALID');
    expect(
      (await createTx({ tagIds: Array.from({ length: 11 }, (_, i) => i + 1) }))
        .body.code,
    ).toBe('TAGS_INVALID');
    expect(
      (
        await request(app)
          .get('/api/transactions')
          .query({ tagId: '1 OR 1=1' })
          .set(auth)
      ).status,
    ).toBe(400);
  });

  it('deleting a tag keeps its transactions', async () => {
    const trip = (await createTag('Viaje')).body;
    const tx = (await createTx({ tagIds: [trip.id] })).body;
    expect(
      (await request(app).delete(`/api/tags/${trip.id}`).set(auth)).status,
    ).toBe(200);
    expect(await Transaction.findByPk(tx.id)).not.toBeNull();
    expect(await TransactionTag.count({ where: { TagId: trip.id } })).toBe(0);
    expect(await Tag.findByPk(trip.id)).toBeNull();
  });
});

describe('tags in stats', () => {
  it('ranks spending per tag over the last days, without transfers or isolated accounts', async () => {
    const trip = (await createTag('Viaje')).body;
    const work = (await createTag('Trabajo')).body;
    const transfer = await createCategory(user, 'Entre cuentas', 'transfer');
    const isolated = await createAccount(user, 'Aparte', {
      isExcludedFromTotals: true,
    });
    await createTx({
      amount: 100,
      date: '2026-03-15',
      tagIds: [trip.id, work.id],
    });
    await createTx({ amount: 50, date: '2026-03-01', tagIds: [trip.id] });
    await createTx({ amount: 999, date: '2026-01-01', tagIds: [trip.id] }); // older than 30 days
    await createTx({
      amount: 500,
      date: '2026-03-15',
      categoryId: transfer.id,
      tagIds: [trip.id],
    });
    await createTx({
      amount: 700,
      date: '2026-03-15',
      paymentMethod: 'account',
      accountId: isolated.id,
      tagIds: [trip.id],
    });

    const res = await request(app)
      .get('/api/stats/top-tags')
      .query({ days: 30 })
      .set(auth);
    expect(res.body.items).toEqual([
      {
        tagId: trip.id,
        name: 'Viaje',
        color: '#2563eb',
        amount: 150,
        count: 2,
      },
      {
        tagId: work.id,
        name: 'Trabajo',
        color: '#2563eb',
        amount: 100,
        count: 1,
      },
    ]);
  });

  it('adds the tags column to the export', async () => {
    const trip = (await createTag('Viaje')).body;
    const work = (await createTag('Trabajo')).body;
    await createTx({ description: 'Hotel', tagIds: [trip.id, work.id] });
    const res = await request(app)
      .get('/api/stats/export')
      .query({ period: '2026-03' })
      .set(auth)
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(res.body);
    const sheet = book.getWorksheet('Transactions');
    const header = sheet.getRow(1).values;
    const row = sheet.getRow(2).values;
    const tags = row[header.indexOf('Tags')];
    expect(tags.split(', ').sort()).toEqual(['Trabajo', 'Viaje']);
  });
});
