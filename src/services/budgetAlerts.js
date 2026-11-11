import { Op, UniqueConstraintError } from 'sequelize';
import {
  Account,
  BudgetAlertLog,
  Category,
  Transaction,
  User,
} from '../models/index.js';
import { sendBudgetAlertEmail } from '../utils/mail.js';

const THRESHOLDS = [80, 100];

const pad = (n) => String(n).padStart(2, '0');
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const formatMoney = (amount, currency, language) => {
  try {
    return new Intl.NumberFormat(language === 'en' ? 'en-US' : 'es', {
      style: 'currency',
      currency,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
};

// The budget a category is measured against: its own, or for a parent without
// one, the sum of its subcategories' budgets (same rule as the stats summary).
async function budgetTargets(category) {
  const targets = [category];
  if (category.parentId) {
    const parent = await Category.findByPk(category.parentId);
    if (parent) targets.push(parent);
  }
  const result = [];
  for (const target of targets) {
    const children = target.parentId
      ? []
      : await Category.findAll({ where: { parentId: target.id } });
    let budget =
      target.monthlyBudget != null ? Number(target.monthlyBudget) : null;
    if (budget == null && children.length > 0) {
      const sums = children.filter((c) => c.monthlyBudget != null);
      if (sums.length)
        budget = sums.reduce((s, c) => s + Number(c.monthlyBudget), 0);
    }
    if (budget && budget > 0) {
      result.push({
        category: target,
        budget,
        ids: [target.id, ...children.map((c) => c.id)],
      });
    }
  }
  return result;
}

// Spending of the month counted like the dashboard: isolated accounts excluded.
async function monthSpend(userId, categoryIds, year, month) {
  const last = new Date(year, month, 0).getDate();
  const where = {
    UserId: userId,
    type: 'expense',
    CategoryId: categoryIds,
    date: {
      [Op.between]: [
        `${year}-${pad(month)}-01`,
        `${year}-${pad(month)}-${pad(last)}`,
      ],
    },
  };
  const isolated = await Account.findAll({
    where: { UserId: userId, isExcludedFromTotals: true },
    attributes: ['id'],
  });
  if (isolated.length) {
    where[Op.or] = [
      { AccountId: null },
      { AccountId: { [Op.notIn]: isolated.map((a) => a.id) } },
    ];
  }
  return Number((await Transaction.sum('amount', { where })) || 0);
}

/**
 * After an expense lands in `categoryId` on `date`, email the user once per
 * threshold (80%, 100%) and month. Only the current month alerts: an old
 * expense entered late is history, not a warning. Never throws.
 */
export async function checkBudgetThresholds(
  userId,
  categoryId,
  date,
  today = localToday(),
) {
  try {
    if (!categoryId || !date || String(date).slice(0, 7) !== today.slice(0, 7))
      return [];
    const user = await User.findByPk(userId);
    if (!user || !user.budgetAlertsEnabled || !user.isActive) return [];
    const category = await Category.findOne({
      where: { id: categoryId, UserId: userId },
    });
    if (!category || category.type !== 'expense') return [];

    const [year, month] = today.split('-').map(Number);
    const sent = [];
    for (const { category: target, budget, ids } of await budgetTargets(
      category,
    )) {
      const spent = await monthSpend(userId, ids, year, month);
      const percent = (spent / budget) * 100;
      const crossed = THRESHOLDS.filter((th) => percent >= th);
      if (!crossed.length) continue;

      // Claim each crossed threshold; the unique index makes a repeat a no-op.
      const claimed = [];
      for (const threshold of crossed) {
        try {
          claimed.push(
            await BudgetAlertLog.create({
              UserId: userId,
              CategoryId: target.id,
              year,
              month,
              threshold,
            }),
          );
        } catch (err) {
          if (!(err instanceof UniqueConstraintError)) throw err;
        }
      }
      if (!claimed.length) continue;

      // Jumping straight past 100% sends one email, not two.
      const threshold = Math.max(...claimed.map((c) => c.threshold));
      try {
        await sendBudgetAlertEmail({
          email: user.email,
          name: user.name,
          language: user.language,
          categoryName: target.name,
          threshold,
          spent: formatMoney(spent, user.currency || 'USD', user.language),
          budget: formatMoney(budget, user.currency || 'USD', user.language),
          percent: Math.round(percent),
        });
        sent.push({ categoryId: target.id, threshold });
      } catch (mailErr) {
        // Release the claim so the next expense retries the email.
        console.error(
          `Budget alert email failed for user ${userId}:`,
          mailErr.message,
        );
        await Promise.all(claimed.map((c) => c.destroy()));
      }
    }
    return sent;
  } catch (err) {
    console.error('Budget alert check failed:', err);
    return [];
  }
}
