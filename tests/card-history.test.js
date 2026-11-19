import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app.js';
import { Transaction } from '../src/models/index.js';
import { createAccount, createCard, createUser } from './helpers.js';

const addTx = (user, card, type, amount, date) =>
  Transaction.create({
    type,
    amount,
    date,
    description: 'x',
    paymentMethod: 'card',
    UserId: user.id,
    CardId: card.id,
  });

const historyFor = async (auth, months) => {
  const res = await request(app)
    .get('/api/cards/history')
    .query(months ? { months } : {})
    .set(auth);
  expect(res.status).toBe(200);
  return res.body;
};

describe('GET /api/cards/history', () => {
  beforeAll(() => {
    // Only Date: faking timers would hang the MySQL driver.
    vi.useFakeTimers({
      toFake: ['Date'],
      now: new Date('2026-03-15T12:00:00'),
    });
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it('requires a token', async () => {
    const res = await request(app).get('/api/cards/history');
    expect(res.status).toBe(401);
  });

  it('adds up the expenses of each month and compares with the previous one', async () => {
    const { user, auth } = await createUser();
    const card = await createCard(user);
    await addTx(user, card, 'expense', 100.5, '2026-01-20');
    await addTx(user, card, 'expense', 80, '2026-02-03');
    await addTx(user, card, 'expense', 20.25, '2026-02-25');
    await addTx(user, card, 'expense', 60, '2026-03-02');

    const [result] = await historyFor(auth, 3);

    expect(result.history).toEqual([
      { month: '2026-01', spent: 100.5 },
      { month: '2026-02', spent: 100.25 },
      { month: '2026-03', spent: 60 },
    ]);
    expect(result.spentThisMonth).toBe(60);
    expect(result.delta).toBe(-40.25);
  });

  it('compares with the month before even when the window is one month', async () => {
    const { user, auth } = await createUser();
    const card = await createCard(user);
    await addTx(user, card, 'expense', 30, '2026-02-10');
    await addTx(user, card, 'expense', 50, '2026-03-10');

    const [result] = await historyFor(auth, 1);

    expect(result.history).toEqual([{ month: '2026-03', spent: 50 }]);
    expect(result.delta).toBe(20);
  });

  it('ignores income on the card', async () => {
    const { user, auth } = await createUser();
    const card = await createCard(user);
    await addTx(user, card, 'income', 500, '2026-03-05');

    const [result] = await historyFor(auth, 1);

    expect(result.spentThisMonth).toBe(0);
  });

  it('keeps cards and users apart', async () => {
    const owner = await createUser();
    const other = await createUser();
    const a = await createCard(owner.user, 'A');
    const b = await createCard(owner.user, 'B');
    const foreign = await createCard(other.user, 'C');
    await addTx(owner.user, a, 'expense', 10, '2026-03-01');
    await addTx(owner.user, b, 'expense', 20, '2026-03-01');
    await addTx(other.user, foreign, 'expense', 999, '2026-03-01');

    const result = await historyFor(owner.auth, 1);

    expect(result).toHaveLength(2);
    expect(result.find((r) => r.cardId === a.id).spentThisMonth).toBe(10);
    expect(result.find((r) => r.cardId === b.id).spentThisMonth).toBe(20);
  });
});

describe('GET /api/transactions?q=', () => {
  it('filters by description within the account', async () => {
    const { user, auth } = await createUser();
    const account = await createAccount(user);
    const add = (description) =>
      Transaction.create({
        type: 'expense',
        amount: 1,
        date: '2026-01-10',
        description,
        paymentMethod: 'account',
        UserId: user.id,
        AccountId: account.id,
      });
    await add('Gasolina Puma');
    await add('Supermercado');
    const other = await createUser();
    await Transaction.create({
      type: 'expense',
      amount: 1,
      date: '2026-01-10',
      description: 'Gasolina ajena',
      paymentMethod: 'cash',
      UserId: other.user.id,
    });

    const res = await request(app)
      .get('/api/transactions')
      .query({ q: 'gasol', accountId: account.id, page: 1, limit: 10 })
      .set(auth);

    expect(res.body.total).toBe(1);
    expect(res.body.items[0].description).toBe('Gasolina Puma');
  });
});
