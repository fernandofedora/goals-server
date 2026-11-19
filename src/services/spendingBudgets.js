import { Op } from 'sequelize';
import { sequelize } from '../config/db.js';
import {
  Account,
  Category,
  SpendingBudget,
  Tag,
  Transaction,
} from '../models/index.js';
import {
  addDays,
  daysBetween,
  nextPeriod,
  periodFor,
  previousPeriod,
} from '../utils/budgetPeriod.js';

export const MAX_BUDGETS = 50;
const MAX_AMOUNT = 999999999.99;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

const pad = (n) => String(n).padStart(2, '0');
export const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const isoOf = (date) => {
  const d = new Date(date);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const round2 = (n) => Math.round(n * 100) / 100;
const fail = (code, message) => ({ error: { code, message } });

const INCLUDE = [
  {
    model: Category,
    attributes: ['id', 'name', 'color', 'type', 'parentId'],
    through: { attributes: [] },
  },
  {
    model: Tag,
    attributes: ['id', 'name', 'color'],
    through: { attributes: [] },
  },
];

/**
 * Checks a budget from the request body (merged over `current` on updates).
 * Returns `{ fields, categories, tags }` or `{ error }`.
 */
export async function validateBudget(userId, body, current = null) {
  const pick = (key, fallback) =>
    body[key] !== undefined ? body[key] : current ? current[key] : fallback;

  const name = String(pick('name', '') ?? '')
    .replace(CONTROL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name || name.length > 60)
    return fail(
      'BUDGET_INVALID_NAME',
      'El nombre debe tener entre 1 y 60 caracteres.',
    );

  const amount = Number(pick('amount', NaN));
  if (
    !Number.isFinite(amount) ||
    amount <= 0 ||
    amount > MAX_AMOUNT ||
    Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6
  ) {
    return fail(
      'BUDGET_INVALID_AMOUNT',
      'El monto debe ser mayor que 0, con hasta 2 decimales.',
    );
  }

  const periodType = pick('periodType', 'monthly');
  if (!['weekly', 'monthly', 'quarterly'].includes(periodType))
    return fail('BUDGET_INVALID_PERIOD', 'Periodo no válido.');
  const startDay = Number(pick('startDay', 1));
  const maxDay = periodType === 'weekly' ? 7 : 31;
  if (!Number.isInteger(startDay) || startDay < 1 || startDay > maxDay) {
    return fail(
      'BUDGET_INVALID_START',
      periodType === 'weekly'
        ? 'Elige el día de la semana en que empieza.'
        : 'El día de inicio va del 1 al 31.',
    );
  }

  const isCatchAll = Boolean(pick('isCatchAll', false));
  const rollover = Boolean(pick('rollover', false));

  const idList = (key, max) => {
    const raw =
      body[key] !== undefined ? body[key] : current ? current[key] : [];
    if (
      !Array.isArray(raw) ||
      raw.length > max ||
      !raw.every((id) => Number.isInteger(id) && id > 0)
    )
      return null;
    return [...new Set(raw)];
  };
  const categoryIds = idList('categoryIds', 50);
  const tagIds = idList('tagIds', 20);
  if (!categoryIds || !tagIds)
    return fail('BUDGET_INVALID_SCOPE', 'Categorías o etiquetas no válidas.');

  const categories = categoryIds.length
    ? await Category.findAll({
        where: { id: categoryIds, UserId: userId, type: 'expense' },
      })
    : [];
  const tags = tagIds.length
    ? await Tag.findAll({ where: { id: tagIds, UserId: userId } })
    : [];
  if (
    categories.length !== categoryIds.length ||
    tags.length !== tagIds.length
  ) {
    return fail(
      'BUDGET_INVALID_SCOPE',
      'Elige tus propias categorías de gasto y etiquetas.',
    );
  }
  if (isCatchAll && (categories.length || tags.length)) {
    return fail(
      'BUDGET_CATCHALL_SCOPE',
      'El presupuesto general cubre todo lo demás: no lleva categorías ni etiquetas.',
    );
  }
  if (!isCatchAll && !categories.length && !tags.length) {
    return fail(
      'BUDGET_EMPTY_SCOPE',
      'Elige al menos una categoría o una etiqueta.',
    );
  }
  if (isCatchAll) {
    const other = await SpendingBudget.findOne({
      where: {
        UserId: userId,
        isCatchAll: true,
        ...(current ? { id: { [Op.ne]: current.id } } : {}),
      },
    });
    if (other)
      return fail('BUDGET_CATCHALL_TAKEN', 'Ya tienes un presupuesto general.');
  }

  return {
    fields: {
      name,
      amount: round2(amount),
      periodType,
      startDay,
      rollover,
      isCatchAll,
    },
    categories,
    tags,
  };
}

export const loadBudgets = (userId, where = {}) =>
  SpendingBudget.findAll({
    where: { UserId: userId, ...where },
    include: INCLUDE,
    order: [['name', 'ASC']],
  });

/**
 * Expenses of a date range, counted like the dashboard: no transfers and no
 * isolated accounts. Split containers are already left out by the model.
 */
async function fetchExpenses(userId, from, to) {
  const where = {
    UserId: userId,
    type: 'expense',
    date: { [Op.between]: [from, to] },
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
  const rows = await Transaction.findAll({
    where,
    attributes: ['id', 'amount', 'date', 'description', 'CategoryId'],
    include: [
      { model: Category, attributes: ['type'] },
      { model: Tag, attributes: ['id'], through: { attributes: [] } },
    ],
    order: [
      ['date', 'DESC'],
      ['id', 'DESC'],
    ],
  });
  return rows
    .filter((t) => t.Category?.type !== 'transfer')
    .map((t) => ({
      id: t.id,
      amount: Number(t.amount),
      date: t.date,
      description: t.description,
      CategoryId: t.CategoryId,
      tagIds: (t.Tags || []).map((tag) => tag.id),
    }));
}

/**
 * Builds a matcher per budget. A budget covers its categories (a parent brings
 * its subcategories) and its tags; the catch-all covers whatever no other
 * budget does.
 */
async function matchers(userId, budgets) {
  const all = await Category.findAll({
    where: { UserId: userId },
    attributes: ['id', 'parentId'],
  });
  const plain = budgets
    .filter((b) => !b.isCatchAll)
    .map((b) => {
      const ids = new Set();
      for (const c of b.Categories || []) {
        ids.add(c.id);
        for (const child of all) if (child.parentId === c.id) ids.add(child.id);
      }
      const tags = new Set((b.Tags || []).map((t) => t.id));
      return {
        id: b.id,
        test: (tx) =>
          ids.has(tx.CategoryId) || tx.tagIds.some((t) => tags.has(t)),
      };
    });
  const byId = new Map(plain.map((m) => [m.id, m.test]));
  const covered = (tx) => plain.some((m) => m.test(tx));
  return (budget) =>
    budget.isCatchAll ? (tx) => !covered(tx) : byId.get(budget.id);
}

const sumIn = (txs, test, { start, end }) =>
  round2(
    txs
      .filter((t) => t.date >= start && t.date <= end && test(t))
      .reduce((s, t) => s + t.amount, 0),
  );

/**
 * Where a budget stands in the period that contains `date`. With rollover, the
 * leftover (or overspending) of every earlier period since the budget was
 * created moves into this one.
 */
function statusOf(budget, test, txs, date) {
  const amount = Number(budget.amount);
  const period = periodFor(budget.periodType, budget.startDay, date);
  let carry = 0;
  if (budget.rollover) {
    let p = periodFor(
      budget.periodType,
      budget.startDay,
      isoOf(budget.createdAt),
    );
    while (p.start < period.start) {
      carry += amount - sumIn(txs, test, p);
      p = nextPeriod(budget.periodType, budget.startDay, p);
    }
  }
  const spent = sumIn(txs, test, period);
  const available = round2(amount + carry);
  return {
    id: budget.id,
    name: budget.name,
    amount,
    periodType: budget.periodType,
    startDay: budget.startDay,
    rollover: budget.rollover,
    isCatchAll: budget.isCatchAll,
    categories: (budget.Categories || []).map((c) => ({
      id: c.id,
      name: c.name,
      color: c.color,
    })),
    tags: (budget.Tags || []).map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color,
    })),
    period,
    spent,
    carry: round2(carry),
    available,
    remaining: round2(available - spent),
    percent:
      available > 0
        ? Math.round((spent / available) * 1000) / 10
        : spent > 0
          ? 100
          : 0,
  };
}

/** Earliest day any budget needs for its rollover, or the period start. */
function earliestNeeded(budgets, date) {
  let earliest = date;
  for (const b of budgets) {
    const own = periodFor(b.periodType, b.startDay, date).start;
    const from = b.rollover
      ? periodFor(b.periodType, b.startDay, isoOf(b.createdAt)).start
      : own;
    if (from < earliest) earliest = from;
    // The detail compares with the period before.
    const prev = previousPeriod(
      b.periodType,
      b.startDay,
      periodFor(b.periodType, b.startDay, date),
    ).start;
    if (prev < earliest) earliest = prev;
  }
  return earliest;
}

/** Status of every budget of the user in the period that contains `date`. */
export async function budgetStatuses(userId, date = localToday()) {
  const budgets = await loadBudgets(userId);
  if (!budgets.length) return [];
  const testFor = await matchers(userId, budgets);
  const txs = await fetchExpenses(
    userId,
    earliestNeeded(budgets, date),
    date > localToday() ? date : localToday(),
  );
  return budgets.map((b) => statusOf(b, testFor(b), txs, date));
}

/**
 * One budget day by day: cumulative spending of the period `offset` periods
 * away from today's (0 = current, -1 = previous…) next to the period before,
 * plus the transactions that counted.
 */
export async function budgetDetail(
  userId,
  budgetId,
  offset = 0,
  today = localToday(),
) {
  const budgets = await loadBudgets(userId);
  const budget = budgets.find((b) => b.id === Number(budgetId));
  if (!budget) return null;
  let period = periodFor(budget.periodType, budget.startDay, today);
  for (let i = 0; i < -offset; i += 1)
    period = previousPeriod(budget.periodType, budget.startDay, period);
  const before = previousPeriod(budget.periodType, budget.startDay, period);

  const testFor = await matchers(userId, budgets);
  const test = testFor(budget);
  const txs = await fetchExpenses(
    userId,
    earliestNeeded([budget], period.start),
    today > period.end ? today : period.end,
  );
  const status = statusOf(budget, test, txs, period.start);

  const cumulative = (p, days) => {
    const out = [];
    let running = 0;
    for (let i = 0; i < days; i += 1) {
      const day = addDays(p.start, i);
      running += txs
        .filter((t) => t.date === day && test(t))
        .reduce((s, t) => s + t.amount, 0);
      out.push(round2(running));
    }
    return out;
  };
  const length = daysBetween(period.start, period.end);
  const prevLength = daysBetween(before.start, before.end);
  const current = cumulative(period, length);
  const previous = cumulative(before, prevLength);
  const series = current.map((spent, i) => {
    const date = addDays(period.start, i);
    return {
      day: i + 1,
      date,
      spent: date <= today ? spent : null,
      previous: previous[Math.min(i, prevLength - 1)],
    };
  });

  return {
    budget: status,
    offset,
    previousPeriod: { ...before, spent: previous[prevLength - 1] ?? 0 },
    series,
    transactions: txs
      .filter((t) => t.date >= period.start && t.date <= period.end && test(t))
      .slice(0, 100)
      .map(({ id, date, description, amount, CategoryId }) => ({
        id,
        date,
        description,
        amount,
        CategoryId,
      })),
  };
}

/** Budgets a new expense counts toward (for the 80% / 100% alerts). */
export async function budgetsCovering(userId, tx) {
  const budgets = await loadBudgets(userId);
  if (!budgets.length) return [];
  const testFor = await matchers(userId, budgets);
  return budgets.filter((b) => testFor(b)(tx));
}

/**
 * One-time move of the old per-category monthly budgets into flexible ones:
 * a monthly budget from day 1 with that category and amount. The category's
 * field is then cleared, so running it again does nothing.
 */
export async function migrateCategoryBudgets() {
  const legacy = await Category.findAll({
    where: { monthlyBudget: { [Op.ne]: null } },
  });
  let moved = 0;
  for (const category of legacy) {
    await sequelize.transaction(async (t) => {
      if (Number(category.monthlyBudget) > 0) {
        const budget = await SpendingBudget.create(
          {
            UserId: category.UserId,
            name: category.name.slice(0, 60),
            amount: category.monthlyBudget,
            periodType: 'monthly',
            startDay: 1,
            migratedFromCategoryId: category.id,
          },
          { transaction: t },
        );
        await budget.setCategories([category.id], { transaction: t });
        moved += 1;
      }
      await category.update({ monthlyBudget: null }, { transaction: t });
    });
  }
  return moved;
}
