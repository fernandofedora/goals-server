import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { CategoryRule, Transaction } from '../src/models/index.js';
import { ruleMatches } from '../src/utils/categoryRules.js';
import { createCategory, createUser } from './helpers.js';

let user;
let auth;
let transport;
let food;
let salary;

const createRule = (body) =>
  request(app).post('/api/rules').set(auth).send(body);
const addTx = (description, amount, extra = {}) =>
  Transaction.create({
    description,
    type: 'expense',
    amount,
    date: '2026-03-10',
    paymentMethod: 'cash',
    UserId: user.id,
    ...extra,
  });

beforeEach(async () => {
  ({ user, auth } = await createUser());
  transport = await createCategory(user, 'Transporte');
  food = await createCategory(user, 'Comida');
  salary = await createCategory(user, 'Salario', 'income');
});

describe('rule matching', () => {
  const rule = (field, operator, value) => ({ field, operator, value });

  it('compares text without caring about case, accents or extra spaces', () => {
    expect(
      ruleMatches(rule('description', 'contains', 'uber'), {
        description: 'Pago UBER *Trip',
      }),
    ).toBe(true);
    expect(
      ruleMatches(rule('description', 'equals', 'cafe'), {
        description: '  Café ',
      }),
    ).toBe(true);
    expect(
      ruleMatches(rule('description', 'startsWith', 'super'), {
        description: 'Súper La Colonia',
      }),
    ).toBe(true);
    expect(
      ruleMatches(rule('description', 'notContains', 'uber'), {
        description: 'Taxi',
      }),
    ).toBe(true);
    expect(
      ruleMatches(rule('description', 'contains', 'uber'), {
        description: 'Taxi',
      }),
    ).toBe(false);
  });

  it('compares amounts to the cent', () => {
    expect(
      ruleMatches(rule('amount', 'equals', '15.5'), { amount: '15.50' }),
    ).toBe(true);
    expect(ruleMatches(rule('amount', 'gt', '100'), { amount: 100.01 })).toBe(
      true,
    );
    expect(ruleMatches(rule('amount', 'lt', '100'), { amount: 100 })).toBe(
      false,
    );
  });
});

describe('rules API', () => {
  it('validates name, operator, value and category', async () => {
    const base = {
      name: 'Uber',
      field: 'description',
      operator: 'contains',
      value: 'uber',
      categoryId: transport.id,
    };
    expect((await createRule({ ...base, name: '' })).body.code).toBe(
      'RULE_INVALID_NAME',
    );
    expect((await createRule({ ...base, operator: 'gt' })).body.code).toBe(
      'RULE_INVALID_OPERATOR',
    );
    expect(
      (
        await createRule({
          ...base,
          field: 'amount',
          operator: 'gt',
          value: 'abc',
        })
      ).body.code,
    ).toBe('RULE_INVALID_AMOUNT');
    expect(
      (await createRule({ ...base, value: 'x'.repeat(101) })).body.code,
    ).toBe('RULE_INVALID_TEXT');
    const other = await createUser();
    const foreign = await createCategory(other.user, 'Ajena');
    expect(
      (await createRule({ ...base, categoryId: foreign.id })).body.code,
    ).toBe('RULE_INVALID_CATEGORY');
    const ok = await createRule(base);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      name: 'Uber',
      priority: 1,
      Category: { name: 'Transporte' },
    });
  });

  it('stores malicious-looking values as plain text', async () => {
    const payload = "'; DROP TABLE Transactions; --";
    const res = await createRule({
      name: payload,
      field: 'description',
      operator: 'contains',
      value: payload,
      categoryId: food.id,
    });
    expect(res.status).toBe(200);
    const stored = await CategoryRule.findByPk(res.body.id);
    expect(stored.value).toBe(payload);
    expect(await Transaction.count()).toBeGreaterThanOrEqual(0);
  });

  it('categorizes a new transaction without category, first rule by priority wins', async () => {
    const broad = await createRule({
      name: 'Todo lo de más de 10',
      field: 'amount',
      operator: 'gt',
      value: '10',
      categoryId: food.id,
    });
    const uber = await createRule({
      name: 'Uber',
      field: 'description',
      operator: 'contains',
      value: 'uber',
      categoryId: transport.id,
    });
    const post = (body) =>
      request(app)
        .post('/api/transactions')
        .set(auth)
        .send({
          type: 'expense',
          date: '2026-03-10',
          paymentMethod: 'cash',
          ...body,
        });

    expect(
      (await post({ description: 'Uber viaje', amount: 25 })).body.Category
        .name,
    ).toBe('Comida');

    await request(app)
      .put('/api/rules/order')
      .set(auth)
      .send({ ids: [uber.body.id, broad.body.id] });
    expect(
      (await post({ description: 'Uber viaje', amount: 25 })).body.Category
        .name,
    ).toBe('Transporte');

    // A category chosen by the user always wins.
    expect(
      (
        await post({
          description: 'Uber viaje',
          amount: 25,
          categoryId: food.id,
        })
      ).body.Category.name,
    ).toBe('Comida');
    // An income never lands in an expense category.
    expect(
      (
        await post({
          description: 'Uber reembolso',
          amount: 25,
          type: 'income',
        })
      ).body.Category,
    ).toBeNull();
  });

  it('suggests a category while typing', async () => {
    await createRule({
      name: 'Uber',
      field: 'description',
      operator: 'contains',
      value: 'uber',
      categoryId: transport.id,
    });
    const hit = await request(app)
      .post('/api/rules/match')
      .set(auth)
      .send({ description: 'UBER *trip', amount: 5, type: 'expense' });
    expect(hit.body).toMatchObject({
      categoryId: transport.id,
      ruleName: 'Uber',
    });
    const miss = await request(app)
      .post('/api/rules/match')
      .set(auth)
      .send({ description: 'Cine', amount: 5, type: 'expense' });
    expect(miss.body).toBeNull();
  });

  it('applies to existing transactions without overwriting manual categories unless asked', async () => {
    const rule = await createRule({
      name: 'Uber',
      field: 'description',
      operator: 'contains',
      value: 'uber',
      categoryId: transport.id,
    });
    await addTx('Uber 1', 10);
    await addTx('Uber 2', 12);
    const manual = await addTx('Uber cena', 30, { CategoryId: food.id });
    await addTx('Uber ingreso', 5, { type: 'income' });
    await addTx('Cine', 8);
    const apply = (body) =>
      request(app)
        .post(`/api/rules/${rule.body.id}/apply-existing`)
        .set(auth)
        .send(body);

    const preview = await apply({ dryRun: true });
    expect(preview.body).toMatchObject({
      uncategorized: 2,
      categorized: 1,
      updated: 0,
    });
    expect(
      await Transaction.count({
        where: { UserId: user.id, CategoryId: transport.id },
      }),
    ).toBe(0);

    expect((await apply({ dryRun: false })).body.updated).toBe(2);
    await manual.reload();
    expect(manual.CategoryId).toBe(food.id);

    expect(
      (await apply({ dryRun: false, includeCategorized: true })).body.updated,
    ).toBe(1);
    await manual.reload();
    expect(manual.CategoryId).toBe(transport.id);
  });

  it('only lets a user reorder, edit or delete their own rules', async () => {
    const mine = await createRule({
      name: 'Uber',
      field: 'description',
      operator: 'contains',
      value: 'uber',
      categoryId: transport.id,
    });
    const other = await createUser();
    expect(
      (
        await request(app)
          .put(`/api/rules/${mine.body.id}`)
          .set(other.auth)
          .send({ name: 'X' })
      ).status,
    ).toBe(404);
    expect(
      (await request(app).delete(`/api/rules/${mine.body.id}`).set(other.auth))
        .status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .put('/api/rules/order')
          .set(auth)
          .send({ ids: [mine.body.id, 999999] })
      ).status,
    ).toBe(400);
    const edited = await request(app)
      .put(`/api/rules/${mine.body.id}`)
      .set(auth)
      .send({ isActive: false });
    expect(edited.body.isActive).toBe(false);
    expect(
      (await request(app).delete(`/api/rules/${mine.body.id}`).set(auth))
        .status,
    ).toBe(200);
  });

  it('keeps salary rules for income', async () => {
    await createRule({
      name: 'Nómina',
      field: 'description',
      operator: 'contains',
      value: 'nomina',
      categoryId: salary.id,
    });
    const res = await request(app)
      .post('/api/transactions')
      .set(auth)
      .send({
        type: 'income',
        description: 'NÓMINA noviembre',
        amount: 1000,
        date: '2026-03-10',
        paymentMethod: 'cash',
      });
    expect(res.body.Category.name).toBe('Salario');
  });
});
