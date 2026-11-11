import request from 'supertest';
import ExcelJS from 'exceljs';
import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { Category, Transaction } from '../src/models/index.js';
import { createCategory, createUser } from './helpers.js';

let user;
let auth;
let home;

const addTx = (description, amount, category, extra = {}) =>
  Transaction.create({
    description,
    type: category?.type ?? 'expense',
    amount,
    date: '2026-03-10',
    paymentMethod: 'cash',
    CategoryId: category?.id ?? null,
    UserId: user.id,
    ...extra,
  });

beforeEach(async () => {
  ({ user, auth } = await createUser());
  home = await createCategory(user, 'Hogar', 'expense', { color: '#111111' });
});

describe('category tree rules', () => {
  it('creates a subcategory that inherits the parent type', async () => {
    const res = await request(app)
      .post('/api/categories')
      .set(auth)
      .send({ name: 'Luz', type: 'income', parentId: home.id });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ parentId: home.id, type: 'expense' });
  });

  it('rejects a grandchild and a parent of another user', async () => {
    const light = await createCategory(user, 'Luz', 'expense', {
      parentId: home.id,
    });
    const deep = await request(app)
      .post('/api/categories')
      .set(auth)
      .send({ name: 'Recibo', parentId: light.id });
    expect(deep.status).toBe(400);
    expect(deep.body.code).toBe('CATEGORY_TOO_DEEP');

    const other = await createUser();
    const foreign = await request(app)
      .post('/api/categories')
      .set(other.auth)
      .send({ name: 'Agua', parentId: home.id });
    expect(foreign.status).toBe(400);
    expect(foreign.body.code).toBe('CATEGORY_INVALID_PARENT');
  });

  it('keeps an older client edit from detaching a subcategory', async () => {
    const light = await createCategory(user, 'Luz', 'expense', {
      parentId: home.id,
    });
    const res = await request(app)
      .put(`/api/categories/${light.id}`)
      .set(auth)
      .send({ name: 'Electricidad', color: '#222222', type: 'expense' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Electricidad', parentId: home.id });
  });

  it('refuses to nest a parent and to make a category its own parent', async () => {
    await createCategory(user, 'Luz', 'expense', { parentId: home.id });
    const other = await createCategory(user, 'Transporte');
    const nest = await request(app)
      .put(`/api/categories/${home.id}`)
      .set(auth)
      .send({ name: 'Hogar', type: 'expense', parentId: other.id });
    expect(nest.status).toBe(400);
    expect(nest.body.code).toBe('CATEGORY_TOO_DEEP');

    const self = await request(app)
      .put(`/api/categories/${other.id}`)
      .set(auth)
      .send({ name: 'Transporte', type: 'expense', parentId: other.id });
    expect(self.status).toBe(400);
    expect(self.body.code).toBe('CATEGORY_INVALID_PARENT');
  });

  it('cascades a parent type change to its children', async () => {
    const light = await createCategory(user, 'Luz', 'expense', {
      parentId: home.id,
    });
    await request(app)
      .put(`/api/categories/${home.id}`)
      .set(auth)
      .send({ name: 'Hogar', type: 'income' });
    await light.reload();
    expect(light.type).toBe('income');
  });

  it('blocks deleting a parent with children or a category in use', async () => {
    const light = await createCategory(user, 'Luz', 'expense', {
      parentId: home.id,
    });
    const parent = await request(app)
      .delete(`/api/categories/${home.id}`)
      .set(auth);
    expect(parent.status).toBe(409);
    expect(parent.body.code).toBe('CATEGORY_HAS_CHILDREN');

    await addTx('Recibo', 30, light);
    const used = await request(app)
      .delete(`/api/categories/${light.id}`)
      .set(auth);
    expect(used.status).toBe(409);
    expect(used.body.code).toBe('CATEGORY_IN_USE');

    const unused = await createCategory(user, 'Viejo');
    const ok = await request(app)
      .delete(`/api/categories/${unused.id}`)
      .set(auth);
    expect(ok.status).toBe(200);
    expect(await Category.findByPk(unused.id)).toBeNull();
  });
});

describe('subcategories in reads', () => {
  let light;
  let water;

  beforeEach(async () => {
    light = await createCategory(user, 'Luz', 'expense', {
      parentId: home.id,
      monthlyBudget: 50,
    });
    water = await createCategory(user, 'Agua', 'expense', {
      parentId: home.id,
      monthlyBudget: 20,
    });
    await addTx('Alquiler', 400, home);
    await addTx('Recibo luz', 45, light);
    await addTx('Recibo agua', 15, water);
  });

  it('groups the summary by parent with a child breakdown', async () => {
    const res = await request(app)
      .get('/api/stats/summary')
      .query({ period: '2026-03' })
      .set(auth);
    expect(res.status).toBe(200);
    expect(res.body.categories).toHaveLength(1);
    const [group] = res.body.categories;
    expect(group).toMatchObject({
      id: home.id,
      name: 'Hogar',
      amount: 460,
      monthlyBudget: 70,
    });
    expect(group.children.map((c) => [c.name, c.amount]).sort()).toEqual([
      ['Agua', 15],
      ['Luz', 45],
    ]);
  });

  it('prefers the parent budget over the sum of its children', async () => {
    await home.update({ monthlyBudget: 600 });
    const res = await request(app)
      .get('/api/stats/summary')
      .query({ period: '2026-03' })
      .set(auth);
    expect(res.body.categories[0].monthlyBudget).toBe(600);
  });

  it('includes subcategories when filtering transactions by the parent', async () => {
    const res = await request(app)
      .get('/api/transactions')
      .query({ page: 1, limit: 50, categoryId: home.id })
      .set(auth);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.totals.expense).toBe(460);

    const child = await request(app)
      .get('/api/transactions')
      .query({ page: 1, limit: 50, categoryId: light.id })
      .set(auth);
    expect(child.body.total).toBe(1);

    const bad = await request(app)
      .get('/api/transactions')
      .query({ categoryId: 'abc' })
      .set(auth);
    expect(bad.status).toBe(400);
  });

  it('rolls children into the parent line of the timeline', async () => {
    const res = await request(app)
      .get('/api/stats/categories-timeline')
      .query({ period: '2026-03' })
      .set(auth);
    expect(res.status).toBe(200);
    expect(res.body.categories.map((c) => c.id)).toEqual([home.id]);
    const total = res.body.series.reduce(
      (s, b) => s + (b[`cat_${home.id}`] || 0),
      0,
    );
    expect(total).toBe(460);

    const childOnly = await request(app)
      .get('/api/stats/categories-timeline')
      .query({ period: '2026-03', categoryIds: String(light.id) })
      .set(auth);
    const childTotal = childOnly.body.series.reduce(
      (s, b) => s + (b[`cat_${light.id}`] || 0),
      0,
    );
    expect(childTotal).toBe(45);
  });

  it('adds the parent column to the export', async () => {
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
    expect(res.status).toBe(200);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(res.body);

    const rowsOf = (name) => {
      const sheet = book.getWorksheet(name);
      const header = sheet.getRow(1).values;
      const rows = [];
      sheet.eachRow((row, i) => {
        if (i === 1) return;
        const entry = {};
        header.forEach((h, j) => (entry[h] = row.values[j]));
        rows.push(entry);
      });
      return rows;
    };

    const light45 = rowsOf('Transactions').find(
      (r) => r.Description === 'Recibo luz',
    );
    expect(light45).toMatchObject({ Category: 'Luz', ParentCategory: 'Hogar' });
    const cats = rowsOf('Categories');
    expect(cats.find((r) => r.Category === 'Hogar')).toMatchObject({
      Amount: 460,
    });
    expect(cats.find((r) => r.Category === 'Agua')).toMatchObject({
      ParentCategory: 'Hogar',
      Amount: 15,
    });
  });
});
