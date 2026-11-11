import { Op } from 'sequelize';
import { Category, SavingsContribution, Transaction } from '../models/index.js';
import { withChildIds } from './categoryTree.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const AVG_MONTH_DAYS = 365.25 / 12;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const dayNumber = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
};
const round2 = (n) => Math.round(n * 100) / 100;

export const isIsoDate = (value) =>
  typeof value === 'string' &&
  DATE_RE.test(value) &&
  !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

/**
 * Where a dated goal stands today. The expected amount grows linearly from the
 * start date to the target date; ±10% around it counts as on track.
 * Without a target date there is no status.
 */
export function goalStatus({ target, saved, startDate, targetDate, today }) {
  if (!targetDate)
    return { status: null, suggestedMonthly: null, expected: null };
  const remaining = Math.max(0, target - saved);
  if (saved >= target) {
    return { status: 'completed', suggestedMonthly: 0, expected: target };
  }

  const start = dayNumber(startDate);
  const end = dayNumber(targetDate);
  const now = dayNumber(today);
  const daysLeft = end - now;
  if (daysLeft <= 0) {
    return {
      status: 'behind',
      suggestedMonthly: round2(remaining),
      expected: target,
    };
  }

  const totalDays = Math.max(1, end - start);
  const elapsed = Math.min(totalDays, Math.max(0, now - start));
  const expected = (target * elapsed) / totalDays;
  let status = 'behind';
  if (saved > expected && saved >= expected * 1.1) status = 'ahead';
  else if (saved >= expected * 0.9) status = 'on_track';

  const monthsLeft = Math.max(1, daysLeft / AVG_MONTH_DAYS);
  return {
    status,
    suggestedMonthly: round2(remaining / monthsLeft),
    expected: round2(expected),
  };
}

const isoDay = (date) => new Date(date).toISOString().slice(0, 10);

/**
 * Totals of a plan: the amount saved before creating it, manual contributions
 * and transactions of the linked category (subcategories included).
 */
export async function planTotals(plan, userId, range = {}) {
  const dateWhere = range.date ? { date: range.date } : {};
  const contributions = await SavingsContribution.findAll({
    where: { planId: plan.id, ...dateWhere },
  });
  const totalManual = contributions.reduce((s, c) => s + Number(c.amount), 0);

  let autoTransactions = [];
  if (plan.linkedCategoryId) {
    // An income category feeds a plan through income transactions, an
    // expense category through expense ones.
    const linked = await Category.findOne({
      where: { id: plan.linkedCategoryId, UserId: userId },
    });
    const where = {
      UserId: userId,
      CategoryId: await withChildIds(userId, plan.linkedCategoryId),
      ...dateWhere,
    };
    if (linked) where.type = linked.type;
    autoTransactions = await Transaction.findAll({
      where,
      order: [['date', 'DESC']],
    });
  }
  const totalAuto = autoTransactions.reduce((s, t) => s + Number(t.amount), 0);
  // The starting amount predates the plan, so a window with a start date leaves it out.
  const initialAmount = range.date?.[Op.gte]
    ? 0
    : Number(plan.initialAmount || 0);

  return {
    contributions,
    autoTransactions,
    totalManual,
    totalAuto,
    initialAmount,
    saved: initialAmount + totalManual + totalAuto,
  };
}

/** Status of a plan as of today, on all-time totals. */
export async function planProgress(plan, userId, today = isoDay(new Date())) {
  const totals = await planTotals(plan, userId);
  return {
    saved: totals.saved,
    ...goalStatus({
      target: Number(plan.targetAmount),
      saved: totals.saved,
      startDate: isoDay(plan.createdAt),
      targetDate: plan.targetDate,
      today,
    }),
  };
}
