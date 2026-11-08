import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { Transaction } from '../src/models/index.js';
import { createAccount, createUser } from './helpers.js';

const addTx = (user, account, type, amount, date = '2026-01-10') =>
  Transaction.create({
    type,
    amount,
    date,
    description: 'x',
    paymentMethod: 'account',
    UserId: user.id,
    AccountId: account.id,
  });

const listFor = (auth, query) =>
  request(app).get('/api/transactions').query(query).set(auth);

// The balance is still derived on the client (Dashboard): this mirrors that formula.
const balanceOf = (account, txs) =>
  Number(account.initialBalance) +
  txs.reduce(
    (sum, t) => sum + (t.type === 'income' ? 1 : -1) * Number(t.amount),
    0,
  );

describe('account transactions', () => {
  it('gives each account exactly the rows its balance is computed from', async () => {
    const { user, auth } = await createUser();
    const a = await createAccount(user, 'A', { initialBalance: 1000.5 });
    const b = await createAccount(user, 'B');
    await addTx(user, a, 'income', 200.25);
    await addTx(user, a, 'expense', 50.75);
    await addTx(user, b, 'expense', 999);

    const res = await listFor(auth, { accountId: a.id });
    expect(res.body).toHaveLength(2);
    expect(balanceOf(a, res.body)).toBeCloseTo(1150, 2);
  });

  it('keeps the rows of an isolated account when asked for it, but not in the general list', async () => {
    const { user, auth } = await createUser();
    const isolated = await createAccount(user, 'Aislada', {
      isExcludedFromTotals: true,
    });
    await addTx(user, isolated, 'expense', 10);

    const direct = await listFor(auth, { accountId: isolated.id });
    const general = await listFor(auth, {});
    expect(direct.body).toHaveLength(1);
    expect(general.body).toHaveLength(0);
  });

  it("does not expose another user's account", async () => {
    const owner = await createUser();
    const intruder = await createUser();
    const account = await createAccount(owner.user);
    await addTx(owner.user, account, 'expense', 10);

    const res = await listFor(intruder.auth, { accountId: account.id });
    expect(res.body).toHaveLength(0);
  });

  it('paginates with the total of the whole set', async () => {
    const { user, auth } = await createUser();
    const account = await createAccount(user);
    for (const day of ['01', '02', '03']) {
      await addTx(user, account, 'expense', 1, `2026-01-${day}`);
    }

    const res = await listFor(auth, {
      accountId: account.id,
      page: 2,
      limit: 2,
    });
    expect(res.body.total).toBe(3);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].date).toBe('2026-01-01');
  });
});

describe('budgets', () => {
  const body = { month: 5, year: 2026 };

  it('creates and updates a monthly budget, and reflects it in the summary', async () => {
    const { auth } = await createUser();
    const created = await request(app)
      .post('/api/budgets')
      .set(auth)
      .send({ ...body, amount: 800.5 });
    await request(app)
      .put(`/api/budgets/${created.body.id}`)
      .set(auth)
      .send({ ...body, amount: 900 });

    const res = await request(app)
      .get('/api/stats/summary')
      .query({ period: '2026-05' })
      .set(auth);
    expect(Number(res.body.budgetAmount)).toBe(900);
  });

  it("cannot read, edit or delete another user's budget", async () => {
    const owner = await createUser();
    const intruder = await createUser();
    const created = await request(app)
      .post('/api/budgets')
      .set(owner.auth)
      .send({ ...body, amount: 100 });
    const url = `/api/budgets/${created.body.id}`;

    const list = await request(app).get('/api/budgets').set(intruder.auth);
    const edit = await request(app)
      .put(url)
      .set(intruder.auth)
      .send({ ...body, amount: 1 });
    const remove = await request(app).delete(url).set(intruder.auth);

    expect(list.body).toHaveLength(0);
    expect(edit.status).toBe(404);
    expect(remove.status).toBe(404);
  });
});
