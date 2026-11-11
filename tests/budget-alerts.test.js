import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app.js';
import { BudgetAlertLog, Transaction } from '../src/models/index.js';
import { checkBudgetThresholds } from '../src/services/budgetAlerts.js';
import { sendBudgetAlertEmail } from '../src/utils/mail.js';
import { createAccount, createCategory, createUser } from './helpers.js';

const TODAY = '2026-03-15';
let user;
let auth;
let food;

const spend = (amount, category = food, extra = {}) =>
  Transaction.create({
    description: 'Gasto',
    type: 'expense',
    amount,
    date: TODAY,
    paymentMethod: 'cash',
    CategoryId: category.id,
    UserId: user.id,
    ...extra,
  });
const check = (category = food, date = TODAY) =>
  checkBudgetThresholds(user.id, category.id, date, TODAY);

beforeEach(async () => {
  sendBudgetAlertEmail.mockReset();
  sendBudgetAlertEmail.mockResolvedValue(undefined);
  ({ user, auth } = await createUser());
  await user.update({ language: 'es', currency: 'USD' });
  food = await createCategory(user, 'Comida', 'expense', {
    monthlyBudget: 100,
  });
});

describe('checkBudgetThresholds', () => {
  it('stays quiet below 80%', async () => {
    await spend(79);
    expect(await check()).toEqual([]);
    expect(sendBudgetAlertEmail).not.toHaveBeenCalled();
  });

  it('emails once at 80% and once at 100%, never twice', async () => {
    await spend(85);
    expect(await check()).toEqual([{ categoryId: food.id, threshold: 80 }]);
    await spend(5);
    expect(await check()).toEqual([]);
    await spend(10);
    expect(await check()).toEqual([{ categoryId: food.id, threshold: 100 }]);
    await spend(50);
    expect(await check()).toEqual([]);
    expect(sendBudgetAlertEmail).toHaveBeenCalledTimes(2);
    expect(sendBudgetAlertEmail.mock.calls[1][0]).toMatchObject({
      email: user.email,
      language: 'es',
      categoryName: 'Comida',
      threshold: 100,
      percent: 100,
      spent: expect.stringContaining('100'),
    });
  });

  it('sends a single email when one expense jumps past 100%', async () => {
    await spend(130);
    expect(await check()).toEqual([{ categoryId: food.id, threshold: 100 }]);
    expect(sendBudgetAlertEmail).toHaveBeenCalledTimes(1);
    expect(await BudgetAlertLog.count({ where: { UserId: user.id } })).toBe(2);
  });

  it('measures a parent without budget against the sum of its children', async () => {
    const home = await createCategory(user, 'Hogar');
    const light = await createCategory(user, 'Luz', 'expense', {
      parentId: home.id,
      monthlyBudget: 60,
    });
    await createCategory(user, 'Agua', 'expense', {
      parentId: home.id,
      monthlyBudget: 40,
    });
    await spend(50, light);
    // Luz is at 83% of 60; Hogar at 50% of 100.
    expect(await check(light)).toEqual([
      { categoryId: light.id, threshold: 80 },
    ]);
    await spend(35, home);
    expect(await check(home)).toEqual([{ categoryId: home.id, threshold: 80 }]);
  });

  it('ignores isolated accounts, past months, income and disabled users', async () => {
    const isolated = await createAccount(user, 'Aparte', {
      isExcludedFromTotals: true,
    });
    await spend(90, food, { AccountId: isolated.id, paymentMethod: 'account' });
    expect(await check()).toEqual([]);

    await spend(90, food, { date: '2026-02-10' });
    expect(await check(food, '2026-02-10')).toEqual([]);

    const salary = await createCategory(user, 'Salario', 'income', {
      monthlyBudget: 10,
    });
    expect(await check(salary)).toEqual([]);

    await spend(90);
    await user.update({ budgetAlertsEnabled: false });
    expect(await check()).toEqual([]);
    expect(sendBudgetAlertEmail).not.toHaveBeenCalled();
  });

  it('retries on the next expense when the email fails', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    sendBudgetAlertEmail.mockRejectedValueOnce(new Error('SMTP down'));
    await spend(85);
    expect(await check()).toEqual([]);
    expect(await BudgetAlertLog.count({ where: { UserId: user.id } })).toBe(0);
    expect(await check()).toEqual([{ categoryId: food.id, threshold: 80 }]);
    errorLog.mockRestore();
  });
});

describe('budget alerts through the API', () => {
  it('alerts after creating an expense and keeps the transaction when mail fails', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-15T12:00:00'));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    sendBudgetAlertEmail.mockRejectedValueOnce(new Error('SMTP down'));
    try {
      const body = {
        type: 'expense',
        description: 'Súper',
        amount: 90,
        date: TODAY,
        paymentMethod: 'cash',
        categoryId: food.id,
      };
      const res = await request(app)
        .post('/api/transactions')
        .set(auth)
        .send(body);
      expect(res.status).toBe(200);
      await vi.waitFor(() =>
        expect(sendBudgetAlertEmail).toHaveBeenCalledTimes(1),
      );
      expect(await Transaction.count({ where: { UserId: user.id } })).toBe(1);

      // The failed email is retried by the next expense.
      await request(app)
        .post('/api/transactions')
        .set(auth)
        .send({ ...body, amount: 1 });
      await vi.waitFor(() =>
        expect(sendBudgetAlertEmail).toHaveBeenCalledTimes(2),
      );
    } finally {
      errorLog.mockRestore();
      vi.useRealTimers();
    }
  });

  it('exposes and saves the preference in the profile', async () => {
    const me = await request(app).get('/api/user/me').set(auth);
    expect(me.body.budgetAlertsEnabled).toBe(true);
    const res = await request(app)
      .put('/api/user/profile')
      .set(auth)
      .send({ budgetAlertsEnabled: false });
    expect(res.body.budgetAlertsEnabled).toBe(false);
  });
});
