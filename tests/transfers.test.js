import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { Transaction } from '../src/models/index.js';
import { createAccount, createCategory, createUser } from './helpers.js';

let user;
let auth;
let food;
let salary;
let transfer;
let bank;
let wallet;

const addTx = (description, type, amount, category, extra = {}) =>
  Transaction.create({
    description,
    type,
    amount,
    date: '2026-03-10',
    paymentMethod: 'cash',
    CategoryId: category.id,
    UserId: user.id,
    ...extra,
  });

beforeEach(async () => {
  ({ user, auth } = await createUser());
  food = await createCategory(user, 'Comida');
  salary = await createCategory(user, 'Salario', 'income');
  transfer = await createCategory(user, 'Entre mis cuentas', 'transfer');
  bank = await createAccount(user, 'Banco', { initialBalance: 1000 });
  wallet = await createAccount(user, 'Billetera');
  await addTx('Súper', 'expense', 40, food);
  await addTx('Nómina', 'income', 500, salary);
  // One transfer, two legs: out of the bank, into the wallet.
  await addTx('A billetera', 'expense', 200, transfer, { AccountId: bank.id, paymentMethod: 'account' });
  await addTx('Desde banco', 'income', 200, transfer, { AccountId: wallet.id, paymentMethod: 'account' });
});

describe('transfer categories', () => {
  it('can be created through the API', async () => {
    const res = await request(app)
      .post('/api/categories')
      .set(auth)
      .send({ name: 'Pago de tarjeta', type: 'transfer', color: '#64748b' });
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('transfer');
  });

  it('stay out of income, expense and category totals', async () => {
    const res = await request(app).get('/api/stats/summary').query({ period: '2026-03' }).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.totals).toMatchObject({ income: 500, expense: 40, balance: 460, transactions: 2 });
    expect(res.body.transfers).toEqual({ in: 200, out: 200, transactions: 2 });
    const names = [...res.body.categories, ...res.body.incomeCategories].map((c) => c.name);
    expect(names).not.toContain('Entre mis cuentas');
    expect(res.body.paymentMethods.account).toBe(0);
  });

  it('still move account balances', async () => {
    const res = await request(app).get('/api/accounts/history').set(auth);
    const balanceOf = (id) => res.body.find((a) => a.accountId === id).balance;
    expect(balanceOf(bank.id)).toBe(800);
    expect(balanceOf(wallet.id)).toBe(200);
  });

  it('apply to both legs in a bulk category change', async () => {
    const legs = await Transaction.findAll({ where: { UserId: user.id, CategoryId: transfer.id } });
    const other = await createCategory(user, 'Ahorro interno', 'transfer');
    const res = await request(app)
      .patch('/api/transactions/bulk')
      .set(auth)
      .send({ ids: legs.map((t) => t.id), categoryId: other.id });
    expect(res.body).toEqual({ updated: 2, skipped: 0 });
  });
});

describe('transfers in the transaction history', () => {
  const list = (query = {}) =>
    request(app).get('/api/transactions').query({ page: 1, limit: 50, ...query }).set(auth);

  it('lists them but leaves them out of the general totals', async () => {
    const res = await list();
    expect(res.body.total).toBe(4);
    expect(res.body.totals).toEqual({ income: 500, expense: 40 });
    expect(res.body.dayTotals['2026-03-10']).toBe(460);
    expect(res.body.transfers).toEqual({ in: 200, out: 200, inTotals: false });
  });

  it('keeps them in the totals of one account', async () => {
    const res = await list({ accountId: bank.id });
    expect(res.body.totals).toEqual({ income: 0, expense: 200 });
    expect(res.body.transfers).toEqual({ in: 0, out: 200, inTotals: true });
  });

  it('reports no transfers when the filtered set has none', async () => {
    const res = await list({ categoryId: food.id });
    expect(res.body.totals).toEqual({ income: 0, expense: 40 });
    expect(res.body.transfers).toBeNull();
  });
});
