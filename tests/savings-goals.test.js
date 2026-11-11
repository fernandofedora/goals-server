import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app.js';
import { SavingsPlan } from '../src/models/index.js';
import { goalStatus } from '../src/utils/savingsProgress.js';
import { createUser } from './helpers.js';

// A 100-day goal of 1000: the expected amount on day 50 is 500.
const base = {
  target: 1000,
  startDate: '2026-01-01',
  targetDate: '2026-04-11',
  today: '2026-02-20',
};

describe('goalStatus', () => {
  it('has no status without a target date', () => {
    expect(goalStatus({ ...base, targetDate: null, saved: 0 })).toEqual({
      status: null,
      suggestedMonthly: null,
      expected: null,
    });
  });

  it('classifies around the expected amount with a 10% band', () => {
    expect(goalStatus({ ...base, saved: 500 })).toMatchObject({
      status: 'on_track',
      expected: 500,
    });
    expect(goalStatus({ ...base, saved: 450 }).status).toBe('on_track');
    expect(goalStatus({ ...base, saved: 449 }).status).toBe('behind');
    expect(goalStatus({ ...base, saved: 550 }).status).toBe('ahead');
  });

  it('is on track on day one with nothing saved', () => {
    expect(
      goalStatus({ ...base, today: base.startDate, saved: 0 }).status,
    ).toBe('on_track');
  });

  it('completes once the target is reached, even late', () => {
    expect(
      goalStatus({ ...base, today: '2026-06-01', saved: 1000 }),
    ).toMatchObject({
      status: 'completed',
      suggestedMonthly: 0,
    });
  });

  it('is behind past the deadline and asks for the whole remainder', () => {
    expect(
      goalStatus({ ...base, today: '2026-05-01', saved: 300 }),
    ).toMatchObject({
      status: 'behind',
      suggestedMonthly: 700,
    });
  });

  it('spreads the remainder over the months left, at least one', () => {
    // 50 days left = 1.64 months: 500 / 1.64 ≈ 304.4
    expect(goalStatus({ ...base, saved: 500 }).suggestedMonthly).toBeCloseTo(
      304.4,
      0,
    );
    // 10 days left still counts as one month.
    expect(
      goalStatus({ ...base, today: '2026-04-01', saved: 900 }).suggestedMonthly,
    ).toBe(100);
  });
});

describe('savings goal routes', () => {
  let user;
  let auth;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
    ({ user, auth } = await createUser());
  });
  afterEach(() => vi.useRealTimers());

  const create = (body) =>
    request(app)
      .post('/api/savings/plans')
      .set(auth)
      .send({ name: 'Viaje', targetAmount: 1000, ...body });

  it('stores the target date and the amount already saved', async () => {
    const res = await create({ targetDate: '2026-04-11', initialAmount: 200 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ targetDate: '2026-04-11' });
    expect(Number(res.body.initialAmount)).toBe(200);
    // Day 0 with 200 already saved is ahead of schedule.
    expect(res.body.progress.status).toBe('ahead');
  });

  it('rejects a bad date or a negative starting amount', async () => {
    expect((await create({ targetDate: '11/04/2026' })).status).toBe(400);
    expect((await create({ initialAmount: -5 })).status).toBe(400);
  });

  it('counts the starting amount in the summary and reports the status', async () => {
    const { body: plan } = await create({
      targetDate: '2026-04-11',
      initialAmount: 100,
    });
    vi.setSystemTime(new Date('2026-02-20T12:00:00Z'));
    await request(app)
      .post('/api/savings/contributions')
      .set(auth)
      .send({ planId: plan.id, amount: 150, date: '2026-02-01' });

    const res = await request(app)
      .get(`/api/savings/plans/${plan.id}/summary`)
      .set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      initialAmount: 100,
      totalManual: 150,
      remaining: 750,
      status: 'behind',
      expected: 500,
    });
    expect(res.body.suggestedMonthly).toBeGreaterThan(0);

    const list = await request(app).get('/api/savings/plans').set(auth);
    expect(list.body.find((p) => p.id === plan.id).progress).toMatchObject({
      status: 'behind',
      saved: 250,
    });
  });

  it('has no status without a target date and lets an edit clear it', async () => {
    const { body: plan } = await create({ targetDate: '2026-04-11' });
    const res = await request(app)
      .put(`/api/savings/plans/${plan.id}`)
      .set(auth)
      .send({ name: 'Viaje', targetAmount: 1000, targetDate: null });
    expect(res.body.targetDate).toBeNull();
    expect(res.body.progress.status).toBeNull();

    // An edit that does not send the goal fields keeps them.
    await request(app)
      .put(`/api/savings/plans/${plan.id}`)
      .set(auth)
      .send({
        name: 'Viaje',
        targetAmount: 1000,
        targetDate: '2026-04-11',
        initialAmount: 50,
      });
    await request(app)
      .put(`/api/savings/plans/${plan.id}`)
      .set(auth)
      .send({ name: 'Viaje largo', targetAmount: 1000 });
    const stored = await SavingsPlan.findByPk(plan.id);
    expect(stored.targetDate).toBe('2026-04-11');
    expect(Number(stored.initialAmount)).toBe(50);
    expect(stored.UserId).toBe(user.id);
  });
});
