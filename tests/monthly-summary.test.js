import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { SavingsPlan, Transaction, User } from '../src/models/index.js';
import {
  buildMonthlySummary,
  previousMonth,
  sendMonthlySummaries,
} from '../src/services/monthlySummary.js';
import { sendMonthlySummaryEmail } from '../src/utils/mail.js';
import { monthlySummaryEmail } from '../src/utils/emailTemplates.js';
import { resetRateLimits } from '../src/middleware/rateLimit.js';
import { unsubscribeUrl } from '../src/utils/unsubscribe.js';
import {
  createAccount,
  createBudget,
  createCategory,
  createUser,
} from './helpers.js';

const TODAY = '2026-11-01';
const OCTOBER = previousMonth(TODAY);
let user;
let food;
let rent;
let salary;

const tx = (type, amount, category, extra = {}) =>
  Transaction.create({
    description: 'x',
    type,
    amount,
    date: '2026-10-15',
    paymentMethod: 'cash',
    CategoryId: category?.id ?? null,
    UserId: user.id,
    ...extra,
  });

/** Calls of the mocked sender for our user only (other files leave users behind). */
const callsForUser = () =>
  sendMonthlySummaryEmail.mock.calls.filter(([arg]) => arg.user.id === user.id);

beforeEach(async () => {
  sendMonthlySummaryEmail.mockReset();
  sendMonthlySummaryEmail.mockResolvedValue(undefined);
  resetRateLimits();
  ({ user } = await createUser());
  await user.update({ isEmailVerified: true, language: 'es', currency: 'USD' });
  food = await createCategory(user, 'Comida');
  rent = await createCategory(user, 'Alquiler');
  salary = await createCategory(user, 'Salario', 'income');
});

describe('previousMonth', () => {
  it('goes back across the year', () => {
    expect(previousMonth('2026-01-03')).toEqual({
      year: 2025,
      month: 12,
      key: '2025-12',
      start: '2025-12-01',
      end: '2025-12-31',
    });
    expect(previousMonth('2026-03-01').end).toBe('2026-02-28');
  });
});

describe('buildMonthlySummary', () => {
  it('adds up the month like the dashboard does', async () => {
    const transfer = await createCategory(user, 'Entre cuentas', 'transfer');
    const isolated = await createAccount(user, 'Aparte', { isExcludedFromTotals: true });
    await tx('income', 2000, salary);
    await tx('expense', 800, rent);
    await tx('expense', 300, food);
    await tx('expense', 100, null);
    await tx('expense', 500, transfer);
    await tx('expense', 999, food, { paymentMethod: 'account', AccountId: isolated.id });
    await tx('expense', 50, food, { date: '2026-11-01' });

    const s = await buildMonthlySummary(user, OCTOBER);
    expect(s).toMatchObject({ income: 2000, expense: 1200, net: 800, savingsRate: 40 });
    expect(s.topCategories).toEqual([
      { name: 'Alquiler', amount: 800, share: 67 },
      { name: 'Comida', amount: 300, share: 25 },
      { name: null, amount: 100, share: 8 },
    ]);
  });

  it('lists budgets that went over and savings goals', async () => {
    await createBudget(user, { name: 'Súper', amount: 200 }, { categories: [food] });
    await SavingsPlan.create({ name: 'Viaje', targetAmount: 1000, initialAmount: 250, UserId: user.id });
    await tx('expense', 300, food);

    const s = await buildMonthlySummary(user, OCTOBER);
    expect(s.savingsRate).toBeNull();
    expect(s.overBudgets).toEqual([{ name: 'Súper', spent: 300, available: 200 }]);
    expect(s.savings).toEqual([{ name: 'Viaje', saved: 250, target: 1000, percent: 25 }]);
  });

  it('is null for a month without income or expenses', async () => {
    expect(await buildMonthlySummary(user, OCTOBER)).toBeNull();
  });
});

describe('sendMonthlySummaries', () => {
  it('sends last month once, even if it runs again', async () => {
    await tx('expense', 10, food);
    await sendMonthlySummaries(TODAY);
    await sendMonthlySummaries('2026-11-02');

    expect(callsForUser()).toHaveLength(1);
    expect(callsForUser()[0][0].month.key).toBe('2026-10');
    await user.reload();
    expect(user.lastMonthlySummarySentFor).toBe('2026-10');
  });

  it('skips users who turned it off and runs only in the first week', async () => {
    await tx('expense', 10, food);
    await sendMonthlySummaries('2026-11-08');
    expect(callsForUser()).toHaveLength(0);

    await user.update({ monthlySummaryEnabled: false });
    await sendMonthlySummaries(TODAY);
    expect(callsForUser()).toHaveLength(0);
  });

  it('does not send a summary of an empty month', async () => {
    await sendMonthlySummaries(TODAY);
    expect(callsForUser()).toHaveLength(0);
  });

  it('retries on the next run when sending fails', async () => {
    await tx('expense', 10, food);
    sendMonthlySummaryEmail.mockImplementation(async ({ user: u }) => {
      if (u.id === user.id) throw new Error('SMTP down');
    });
    await sendMonthlySummaries(TODAY);
    await user.reload();
    expect(user.lastMonthlySummarySentFor).toBeNull();

    sendMonthlySummaryEmail.mockResolvedValue(undefined);
    await sendMonthlySummaries('2026-11-02');
    await user.reload();
    expect(user.lastMonthlySummarySentFor).toBe('2026-10');
  });
});

describe('POST /api/user/unsubscribe', () => {
  const linkParams = () =>
    Object.fromEntries(new URL(unsubscribeUrl('monthly', user.publicId), 'http://x').searchParams);

  it('turns the summary off with the link from the email', async () => {
    const res = await request(app).post('/api/user/unsubscribe').send(linkParams());
    expect(res.status).toBe(200);
    expect((await User.findByPk(user.id)).monthlySummaryEnabled).toBe(false);
  });

  it('rejects a tampered link', async () => {
    const params = { ...linkParams(), t: 'x'.repeat(32) };
    const res = await request(app).post('/api/user/unsubscribe').send(params);
    expect(res.status).toBe(400);
    expect((await User.findByPk(user.id)).monthlySummaryEnabled).toBe(true);
  });
});

describe('monthlySummaryEmail', () => {
  const summary = {
    income: 2000,
    expense: 1200,
    net: 800,
    savingsRate: 40,
    transactions: 3,
    topCategories: [
      { name: '<b>Alquiler</b>', amount: 800, share: 67 },
      { name: null, amount: 100, share: 8 },
    ],
    overBudgets: [],
    savings: [],
  };

  it('names the month, translates "no category" and escapes names', () => {
    const mail = monthlySummaryEmail({
      name: 'Ana',
      language: 'es',
      currency: 'USD',
      month: OCTOBER,
      summary,
      unsubscribeUrl: 'https://goals.example/unsubscribe?x=1',
    });
    expect(mail.subject).toBe('Tu resumen de octubre de 2026');
    expect(mail.html).toContain('Sin categoría');
    expect(mail.html).toContain('&lt;b&gt;Alquiler&lt;/b&gt;');
    expect(mail.html).toContain('https://goals.example/unsubscribe?x=1');
    expect(mail.text).toContain('40% de tus ingresos');
    expect(mail.html).not.toContain('Presupuestos que se pasaron');
  });

  it('writes in English', () => {
    const mail = monthlySummaryEmail({
      name: 'Ana',
      language: 'en',
      currency: 'USD',
      month: OCTOBER,
      summary,
      unsubscribeUrl: 'u',
    });
    expect(mail.subject).toBe('Your October 2026 summary');
    expect(mail.html).toContain('$2,000.00');
  });
});
