import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app.js';
import { Transaction } from '../src/models/index.js';
import { cardCycle } from '../src/utils/cardCycle.js';
import {
  createAccount,
  createCard,
  createCategory,
  createUser,
} from './helpers.js';

describe('cardCycle', () => {
  it('runs from the day after the last statement through the next one', () => {
    expect(cardCycle(15, 5, '2026-03-20')).toEqual({
      current: { start: '2026-03-16', end: '2026-04-15' },
      previous: { start: '2026-02-16', end: '2026-03-15' },
      statementDate: '2026-03-15',
      dueDate: '2026-04-05',
    });
    // Before this month's statement, the last one was last month's.
    expect(cardCycle(15, 5, '2026-03-10').statementDate).toBe('2026-02-15');
    // A statement today closes today's cycle.
    expect(cardCycle(15, 25, '2026-03-15')).toMatchObject({
      statementDate: '2026-03-15',
      dueDate: '2026-03-25',
    });
  });

  it('falls on the last valid day in short months', () => {
    expect(cardCycle(31, 20, '2026-03-05')).toMatchObject({
      previous: { start: '2026-02-01', end: '2026-02-28' },
      current: { start: '2026-03-01', end: '2026-03-31' },
    });
    expect(cardCycle(30, 25, '2026-03-01').previous).toEqual({
      start: '2026-01-31',
      end: '2026-02-28',
    });
    expect(cardCycle(31, 31, '2028-03-01')).toMatchObject({
      statementDate: '2028-02-29',
      dueDate: '2028-03-31',
    });
    // Due day before the statement day: next month, clamped.
    expect(cardCycle(10, 31, '2026-02-12').dueDate).toBe('2026-02-28');
  });
});

describe('credit cards API', () => {
  let user;
  let auth;
  let card;
  let transfer;

  const tx = (type, amount, date, extra = {}) =>
    Transaction.create({
      type,
      amount,
      date,
      description: type,
      paymentMethod: 'card',
      CardId: card.id,
      UserId: user.id,
      ...extra,
    });

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-20T12:00:00'));
    ({ user, auth } = await createUser());
    card = await createCard(user, 'Visa');
    transfer = await createCategory(user, 'Pago de tarjeta', 'transfer');
  });
  afterEach(() => vi.useRealTimers());

  it('validates limit and days, and clears them with null', async () => {
    const put = (body) =>
      request(app)
        .put(`/api/cards/${card.id}`)
        .set(auth)
        .send({ name: 'Visa', color: '#000', last4: '4242', ...body });
    expect((await put({ creditLimit: -5 })).body.code).toBe(
      'CARD_INVALID_LIMIT',
    );
    expect((await put({ creditLimit: 'mucho' })).body.code).toBe(
      'CARD_INVALID_LIMIT',
    );
    expect((await put({ statementDay: 32 })).body.code).toBe(
      'CARD_INVALID_DAY',
    );
    expect((await put({ dueDay: 2.5 })).body.code).toBe('CARD_INVALID_DAY');
    const ok = await put({
      creditLimit: '1500.505',
      statementDay: 15,
      dueDay: 5,
    });
    expect(ok.body).toMatchObject({ statementDay: 15, dueDay: 5 });
    expect(Number(ok.body.creditLimit)).toBe(1500.51);
    // An older client that does not send the fields keeps them.
    await request(app)
      .put(`/api/cards/${card.id}`)
      .set(auth)
      .send({ name: 'Visa Oro', color: '#000', last4: '4242' });
    await card.reload();
    expect(card.statementDay).toBe(15);
    expect(
      (await put({ creditLimit: null, statementDay: '' })).body,
    ).toMatchObject({ creditLimit: null, statementDay: null });
  });

  it('reports balance, limit use, the running cycle and the statement to pay', async () => {
    await card.update({ creditLimit: 1000, statementDay: 15, dueDay: 5 });
    await tx('expense', 200, '2026-02-20');
    await tx('expense', 50, '2026-03-01');
    await tx('income', 10, '2026-03-10'); // refund: lowers the closed cycle
    await tx('income', 100, '2026-03-17', { CategoryId: transfer.id }); // payment
    await tx('expense', 80, '2026-03-18');

    const res = await request(app).get('/api/cards/status').set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      cardId: card.id,
      creditLimit: 1000,
      balance: 220,
      available: 780,
      usedPercent: 22,
      cycle: { start: '2026-03-16', end: '2026-04-15', spent: 80 },
      statement: {
        date: '2026-03-15',
        amount: 240,
        dueDate: '2026-04-05',
        paid: 100,
        remaining: 140,
      },
    });
  });

  it('works for a card without credit details', async () => {
    await tx('expense', 30, '2026-03-02');
    const [status] = (await request(app).get('/api/cards/status').set(auth))
      .body;
    expect(status).toMatchObject({
      balance: 30,
      creditLimit: null,
      usedPercent: null,
      cycle: null,
      statement: null,
    });
  });

  it('subtracts the debt of cards with a limit from the net worth', async () => {
    await createAccount(user, 'Banco', { initialBalance: 1000 });
    const plain = await createCard(user, 'Sin límite');
    await tx('expense', 300, '2026-03-02');
    await tx('expense', 999, '2026-03-02', { CardId: plain.id });

    const before = (await request(app).get('/api/stats/net-worth').set(auth))
      .body;
    expect(before.current).toMatchObject({
      accounts: 1000,
      debts: 0,
      total: 1000,
    });

    await card.update({ creditLimit: 2000 });
    const after = (await request(app).get('/api/stats/net-worth').set(auth))
      .body;
    expect(after.current).toMatchObject({
      accounts: 1000,
      debts: 300,
      total: 700,
    });
    expect(after.history.find((h) => h.month === '2026-02')).toMatchObject({
      debts: 0,
    });
  });

  it('only shows the user own cards', async () => {
    const other = await createUser();
    await createCard(other.user, 'Ajena');
    const res = await request(app).get('/api/cards/status').set(auth);
    expect(res.body.map((s) => s.cardId)).toEqual([card.id]);
  });
});
