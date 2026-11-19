import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { processScheduledPayments } from '../src/cron.js';
import { ScheduledPayment, Transaction } from '../src/models/index.js';
import { createAccount, createCard, createUser } from './helpers.js';

const TODAY = '2026-03-15';

const schedule = (user, fields) =>
  ScheduledPayment.create({
    name: 'Pago',
    type: 'expense',
    amount: 25.5,
    period: 'monthly',
    startDate: '2026-01-01',
    endDate: '2030-01-01',
    nextDueDate: TODAY,
    paymentMethod: 'cash',
    UserId: user.id,
    ...fields,
  });

const datesOf = async (payment) => {
  const rows = await Transaction.findAll({
    where: { ScheduledPaymentId: payment.id },
    order: [['date', 'ASC']],
  });
  return rows.map((r) => r.date);
};

describe('processScheduledPayments', () => {
  beforeAll(() => {
    // Only Date: faking timers would hang the MySQL driver.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(`${TODAY}T12:00:00`) });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterAll(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('creates one transaction per missed period and moves nextDueDate to the future', async () => {
    const { user } = await createUser();
    const p = await schedule(user, { nextDueDate: '2026-01-10' });

    await processScheduledPayments();
    await p.reload();

    expect(await datesOf(p)).toEqual([
      '2026-01-10',
      '2026-02-10',
      '2026-03-10',
    ]);
    expect(p.nextDueDate).toBe('2026-04-10');
    expect(p.status).toBe('active');
  });

  it('copies amount, type and description', async () => {
    const { user } = await createUser();
    const p = await schedule(user, {
      type: 'income',
      amount: 1234.56,
      name: 'Sueldo',
    });

    await processScheduledPayments();
    const tx = await Transaction.findOne({
      where: { ScheduledPaymentId: p.id },
    });

    expect(Number(tx.amount)).toBe(1234.56);
    expect(tx.type).toBe('income');
    expect(tx.description).toBe('Scheduled: Sueldo');
    expect(tx.UserId).toBe(user.id);
  });

  it('does not create anything twice when it runs again', async () => {
    const { user } = await createUser();
    const p = await schedule(user, { nextDueDate: '2026-02-15' });

    await processScheduledPayments();
    await processScheduledPayments();

    expect(await datesOf(p)).toEqual(['2026-02-15', '2026-03-15']);
  });

  it('ignores future and paused payments', async () => {
    const { user } = await createUser();
    const future = await schedule(user, { nextDueDate: '2026-03-16' });
    const paused = await schedule(user, {
      nextDueDate: '2026-01-01',
      status: 'paused',
    });

    await processScheduledPayments();

    expect(await datesOf(future)).toEqual([]);
    expect(await datesOf(paused)).toEqual([]);
  });

  it('stops and pauses when the occurrences run out', async () => {
    const { user } = await createUser();
    const p = await schedule(user, {
      nextDueDate: '2026-01-10',
      occurrences: 2,
    });

    await processScheduledPayments();
    await p.reload();

    expect(await datesOf(p)).toEqual(['2026-01-10', '2026-02-10']);
    expect(p.occurrences).toBe(0);
    expect(p.status).toBe('paused');
  });

  it('never goes past the end date', async () => {
    const { user } = await createUser();
    const p = await schedule(user, {
      nextDueDate: '2026-01-10',
      endDate: '2026-02-20',
    });

    await processScheduledPayments();
    await p.reload();

    expect(await datesOf(p)).toEqual(['2026-01-10', '2026-02-10']);
    expect(p.status).toBe('paused');
  });

  it('links only the card or account of the payment method', async () => {
    const { user } = await createUser();
    const card = await createCard(user);
    const account = await createAccount(user);
    const links = { CardId: card.id, AccountId: account.id };
    const byCard = await schedule(user, { paymentMethod: 'card', ...links });
    const byAccount = await schedule(user, {
      paymentMethod: 'account',
      ...links,
    });

    await processScheduledPayments();
    const cardTx = await Transaction.findOne({
      where: { ScheduledPaymentId: byCard.id },
    });
    const accountTx = await Transaction.findOne({
      where: { ScheduledPaymentId: byAccount.id },
    });

    expect([cardTx.CardId, cardTx.AccountId]).toEqual([card.id, null]);
    expect([accountTx.CardId, accountTx.AccountId]).toEqual([null, account.id]);
  });

  it('goes back to the original day after a short month', async () => {
    const { user } = await createUser();
    const p = await schedule(user, {
      startDate: '2026-01-31',
      nextDueDate: '2026-01-31',
    });

    await processScheduledPayments();
    await p.reload();

    expect(await datesOf(p)).toEqual(['2026-01-31', '2026-02-28']);
    expect(p.nextDueDate).toBe('2026-03-31');
  });
});
