import { Op } from 'sequelize';
import {
  Account,
  Category,
  SavingsPlan,
  Transaction,
  User,
} from '../models/index.js';
import { groupByParent } from '../utils/categoryTree.js';
import { planTotals } from '../utils/savingsProgress.js';
import { sendMonthlySummaryEmail } from '../utils/mail.js';
import { budgetStatuses, localToday } from './spendingBudgets.js';

// The job runs daily but only sends in the first days of the month: the host
// may be asleep on the 1st, and a summary that arrives mid-month is noise.
export const SEND_WINDOW_DAYS = 7;
const TOP_CATEGORIES = 3;
const MAX_PLANS = 3;

const pad = (n) => String(n).padStart(2, '0');
const round2 = (n) => Math.round(n * 100) / 100;

/** The calendar month before `today` ('YYYY-MM-DD'). */
export function previousMonth(today) {
  const [y, m] = today.split('-').map(Number);
  const year = m === 1 ? y - 1 : y;
  const month = m === 1 ? 12 : m - 1;
  const lastDay = new Date(year, month, 0).getDate();
  return {
    year,
    month,
    key: `${year}-${pad(month)}`,
    start: `${year}-${pad(month)}-01`,
    end: `${year}-${pad(month)}-${pad(lastDay)}`,
  };
}

/**
 * Figures for one user and month, with the same rules as the dashboard:
 * transfers and "no integrar" accounts are left out. Null when the month has
 * no income or expenses, so nobody gets a summary of zeros.
 */
export async function buildMonthlySummary(user, { start, end }) {
  const isolated = await Account.findAll({
    where: { UserId: user.id, isExcludedFromTotals: true },
    attributes: ['id'],
  });
  const where = { UserId: user.id, date: { [Op.between]: [start, end] } };
  if (isolated.length) {
    where[Op.or] = [
      { AccountId: null },
      { AccountId: { [Op.notIn]: isolated.map((a) => a.id) } },
    ];
  }
  const loaded = await Transaction.findAll({ where, include: [Category] });
  const txs = loaded.filter((t) => t.Category?.type !== 'transfer');
  if (!txs.length) return null;

  const sum = (type) =>
    round2(txs.filter((t) => t.type === type).reduce((a, t) => a + Number(t.amount), 0));
  const income = sum('income');
  const expense = sum('expense');

  const categories = await Category.findAll({ where: { UserId: user.id } });
  const topCategories = groupByParent(txs, categories, 'expense', '#3b82f6')
    .sort((a, b) => b.amount - a.amount)
    .slice(0, TOP_CATEGORIES)
    .map((c) => ({
      // null = no category; the email names it in the user's language.
      name: c.id ? c.name : null,
      amount: round2(c.amount),
      share: expense > 0 ? Math.round((c.amount / expense) * 100) : 0,
    }));

  // Budgets as they stood on the last day of the month.
  const overBudgets = (await budgetStatuses(user.id, end))
    .filter((b) => b.spent > b.available)
    .map((b) => ({ name: b.name, spent: round2(b.spent), available: round2(b.available) }));

  const plans = await SavingsPlan.findAll({
    where: { UserId: user.id, status: 'active' },
    order: [['createdAt', 'ASC']],
    limit: MAX_PLANS,
  });
  const savings = [];
  for (const plan of plans) {
    const all = await planTotals(plan, user.id);
    const target = Number(plan.targetAmount);
    savings.push({
      name: plan.name,
      saved: round2(all.saved),
      target: round2(target),
      percent: target > 0 ? Math.min(100, Math.round((all.saved / target) * 100)) : 0,
    });
  }

  return {
    income,
    expense,
    net: round2(income - expense),
    // Share of income that was not spent; meaningless without income.
    savingsRate: income > 0 ? Math.round(((income - expense) / income) * 100) : null,
    transactions: txs.length,
    topCategories,
    overBudgets,
    savings,
  };
}

/**
 * Sends last month's summary to every user who wants it and has not had it.
 * Each user is claimed with a conditional UPDATE before sending, so two runs
 * (cron + startup, or two processes) never both send. A failed send releases
 * the claim and the next run retries. Never throws; returns how many were sent.
 */
export async function sendMonthlySummaries(today = localToday()) {
  if (Number(today.slice(8, 10)) > SEND_WINDOW_DAYS) return 0;
  const month = previousMonth(today);

  const users = await User.findAll({
    where: {
      isActive: true,
      isEmailVerified: true,
      monthlySummaryEnabled: true,
      [Op.or]: [
        { lastMonthlySummarySentFor: null },
        { lastMonthlySummarySentFor: { [Op.ne]: month.key } },
      ],
    },
  });

  let sent = 0;
  for (const user of users) {
    const previous = user.lastMonthlySummarySentFor;
    let claimed = 0;
    try {
      [claimed] = await User.update(
        { lastMonthlySummarySentFor: month.key },
        { where: { id: user.id, lastMonthlySummarySentFor: previous } },
      );
      if (!claimed) continue;

      const summary = await buildMonthlySummary(user, month);
      // A quiet month keeps the claim: there is nothing to send later either.
      if (!summary) continue;

      await sendMonthlySummaryEmail({ user, month, summary });
      sent += 1;
    } catch (err) {
      console.error(`Monthly summary failed for user ${user.id}:`, err.message);
      if (claimed) {
        await User.update(
          { lastMonthlySummarySentFor: previous },
          { where: { id: user.id, lastMonthlySummarySentFor: month.key } },
        ).catch(() => {});
      }
    }
  }
  return sent;
}
