import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app.js';
import { Transaction } from '../src/models/index.js';
import { createAccount, createUser } from './helpers.js';

const addTx = (user, account, type, amount, date) =>
  Transaction.create({
    type,
    amount,
    date,
    description: 'x',
    paymentMethod: 'account',
    UserId: user.id,
    AccountId: account.id,
  });

const historyFor = async (auth, months) => {
  const res = await request(app)
    .get('/api/accounts/history')
    .query(months ? { months } : {})
    .set(auth);
  expect(res.status).toBe(200);
  return res.body;
};

describe('GET /api/accounts/history', () => {
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
    const res = await request(app).get('/api/accounts/history');
    expect(res.status).toBe(401);
  });

  it('returns an empty list without accounts', async () => {
    const { auth } = await createUser();
    expect(await historyFor(auth)).toEqual([]);
  });

  it('accumulates the closing balance of each month', async () => {
    const { user, auth } = await createUser();
    const account = await createAccount(user, 'A', { initialBalance: 1000 });
    await addTx(user, account, 'income', 500, '2026-01-10');
    await addTx(user, account, 'expense', 200, '2026-02-05');
    await addTx(user, account, 'expense', 50.5, '2026-03-01');

    const [result] = await historyFor(auth, 3);

    expect(result.history).toEqual([
      { month: '2026-01', balance: 1500 },
      { month: '2026-02', balance: 1300 },
      { month: '2026-03', balance: 1249.5 },
    ]);
    expect(result.balance).toBe(1249.5);
    expect(result.delta).toBe(-50.5);
  });

  it('carries everything before the window into the first month', async () => {
    const { user, auth } = await createUser();
    const account = await createAccount(user, 'A', { initialBalance: 100 });
    await addTx(user, account, 'income', 900, '2024-06-01');
    await addTx(user, account, 'expense', 10, '2026-03-02');

    const [result] = await historyFor(auth, 2);

    expect(result.history).toEqual([
      { month: '2026-02', balance: 1000 },
      { month: '2026-03', balance: 990 },
    ]);
  });

  it('has twelve months by default, ending in the current one', async () => {
    const { user, auth } = await createUser();
    await createAccount(user);

    const [result] = await historyFor(auth);

    expect(result.history).toHaveLength(12);
    expect(result.history[0].month).toBe('2025-04');
    expect(result.history[11].month).toBe('2026-03');
  });

  it('stays flat with a zero delta when nothing moved', async () => {
    const { user, auth } = await createUser();
    await createAccount(user, 'A', { initialBalance: 75.25 });

    const [result] = await historyFor(auth, 2);

    expect(result.history.map((h) => h.balance)).toEqual([75.25, 75.25]);
    expect(result.delta).toBe(0);
  });

  it('counts future-dated rows in the balance but not in the months shown', async () => {
    const { user, auth } = await createUser();
    const account = await createAccount(user, 'A', { initialBalance: 100 });
    await addTx(user, account, 'expense', 40, '2026-05-01');

    const [result] = await historyFor(auth, 2);

    expect(result.balance).toBe(60);
    expect(result.history[1].balance).toBe(100);
    expect(result.delta).toBe(0);
  });

  it('does not lose cents over many small amounts', async () => {
    const { user, auth } = await createUser();
    const account = await createAccount(user);
    for (let i = 0; i < 10; i += 1) {
      await addTx(user, account, 'income', 0.1, '2026-03-05');
    }

    const [result] = await historyFor(auth, 1);

    expect(result.balance).toBe(1);
    expect(result.delta).toBe(1);
  });

  it('keeps accounts and users apart', async () => {
    const owner = await createUser();
    const other = await createUser();
    const a = await createAccount(owner.user, 'A');
    const b = await createAccount(owner.user, 'B');
    const foreign = await createAccount(other.user, 'C');
    await addTx(owner.user, a, 'income', 10, '2026-03-01');
    await addTx(owner.user, b, 'income', 20, '2026-03-01');
    await addTx(other.user, foreign, 'income', 999, '2026-03-01');

    const result = await historyFor(owner.auth, 1);

    expect(result.map((r) => r.accountId).sort()).toEqual([a.id, b.id].sort());
    expect(result.find((r) => r.accountId === a.id).balance).toBe(10);
    expect(result.find((r) => r.accountId === b.id).balance).toBe(20);
  });
});
