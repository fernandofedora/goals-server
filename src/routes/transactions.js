import express from 'express';
import { Op, col, fn } from 'sequelize';
import { authMiddleware } from '../middleware/auth.js';
import { withChildIds } from '../utils/categoryTree.js';
import { checkBudgetThresholds } from '../services/budgetAlerts.js';
import { Transaction, Category, Card, Account } from '../models/index.js';

const router = express.Router();
router.use(authMiddleware);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BULK_IDS = 500;

const parseIds = (ids) =>
  Array.isArray(ids) &&
  ids.length > 0 &&
  ids.length <= MAX_BULK_IDS &&
  ids.every((id) => Number.isInteger(id) && id > 0)
    ? ids
    : null;

// Translates the list filters into a WHERE clause; `error` names a bad value.
function buildFilters(query, userId) {
  const { cardId, accountId, categoryId, type, paymentMethod } = query;
  const { q, from, to, minAmount, maxAmount } = query;
  const where = { UserId: userId };
  if (cardId) where.CardId = cardId;
  if (accountId) where.AccountId = accountId;
  if (categoryId) {
    if (!/^\d+$/.test(String(categoryId))) return { error: 'categoryId' };
    where.CategoryId = categoryId;
  }

  if (type) {
    if (!['expense', 'income'].includes(type)) return { error: 'type' };
    where.type = type;
  }
  if (paymentMethod) {
    if (!['cash', 'card', 'account'].includes(paymentMethod)) {
      return { error: 'paymentMethod' };
    }
    where.paymentMethod = paymentMethod;
  }
  // Escaped so a search for "50%" means that text, not a wildcard.
  if (q) {
    where.description = {
      [Op.like]: `%${String(q).replace(/[\\%_]/g, '\\$&')}%`,
    };
  }

  if ((from && !DATE_RE.test(from)) || (to && !DATE_RE.test(to))) {
    return { error: 'date' };
  }
  if (from || to) {
    where.date = {
      ...(from ? { [Op.gte]: from } : {}),
      ...(to ? { [Op.lte]: to } : {}),
    };
  }

  const min =
    minAmount === undefined || minAmount === '' ? null : Number(minAmount);
  const max =
    maxAmount === undefined || maxAmount === '' ? null : Number(maxAmount);
  if (
    (min !== null && !Number.isFinite(min)) ||
    (max !== null && !Number.isFinite(max))
  ) {
    return { error: 'amount' };
  }
  if (min !== null || max !== null) {
    where.amount = {
      ...(min !== null ? { [Op.gte]: min } : {}),
      ...(max !== null ? { [Op.lte]: max } : {}),
    };
  }
  return { where };
}

const toCents = (total) => Math.round(Number(total) * 100);

// Income and expense of the whole filtered set, not just the current page.
async function filteredTotals(where) {
  const rows = await Transaction.findAll({
    attributes: ['type', [fn('SUM', col('amount')), 'total']],
    where,
    group: ['type'],
    raw: true,
  });
  const of = (type) =>
    toCents(rows.find((r) => r.type === type)?.total ?? 0) / 100;
  return { income: of('income'), expense: of('expense') };
}

// Net per day, complete even when a day is split across two pages.
async function netPerDay(where, dates) {
  if (dates.length === 0) return {};
  const rows = await Transaction.findAll({
    attributes: ['date', 'type', [fn('SUM', col('amount')), 'total']],
    where: { ...where, date: dates },
    group: ['date', 'type'],
    raw: true,
  });
  const cents = {};
  for (const r of rows) {
    const sign = r.type === 'income' ? 1 : -1;
    cents[r.date] = (cents[r.date] || 0) + sign * toCents(r.total);
  }
  return Object.fromEntries(
    Object.entries(cents).map(([date, value]) => [date, value / 100]),
  );
}

router.get('/', async (req, res) => {
  const { cardId, accountId, page, limit } = req.query;
  const { where, error } = buildFilters(req.query, req.userId);
  if (error) return res.status(400).json({ message: `Invalid ${error}` });
  // A parent category also lists the transactions of its subcategories.
  if (req.query.categoryId) {
    where.CategoryId = await withChildIds(req.userId, req.query.categoryId);
  }

  // General history (no specific card/account requested): hide transactions of
  // isolated ("no integrar") accounts, but keep account-less ones (cash/card).
  if (!accountId && !cardId) {
    const isolated = await Account.findAll({
      where: { UserId: req.userId, isExcludedFromTotals: true },
      attributes: ['id'],
    });
    const isolatedIds = isolated.map((a) => a.id);
    if (isolatedIds.length > 0) {
      where[Op.or] = [
        { AccountId: null },
        { AccountId: { [Op.notIn]: isolatedIds } },
      ];
    }
  }

  const commonOptions = {
    where,
    attributes: { exclude: ['UserId'] },
    include: [
      { model: Category, attributes: { exclude: ['UserId'] } },
      { model: Card, attributes: { exclude: ['UserId'] } },
      { model: Account, attributes: { exclude: ['UserId'] } },
    ],
    // id breaks ties so rows of the same day never repeat across pages.
    order: [
      ['date', 'DESC'],
      ['id', 'DESC'],
    ],
  };

  const hasPagination = page !== undefined || limit !== undefined;

  if (hasPagination) {
    const pageInt = Math.max(parseInt(page || '1', 10), 1);
    const limitInt = Math.max(parseInt(limit || '20', 10), 1);
    const offset = (pageInt - 1) * limitInt;
    const { rows, count } = await Transaction.findAndCountAll({
      ...commonOptions,
      offset,
      limit: limitInt,
    });
    const dates = [...new Set(rows.map((r) => r.date))];
    const [totals, dayTotals] = await Promise.all([
      filteredTotals(where),
      netPerDay(where, dates),
    ]);
    res.json({
      items: rows,
      page: pageInt,
      limit: limitInt,
      total: count,
      totals,
      dayTotals,
    });
    return;
  }

  const items = await Transaction.findAll(commonOptions);
  res.json(items);
});

// Only rows of the same type as the category change; the rest are reported.
router.patch('/bulk', async (req, res) => {
  const ids = parseIds(req.body.ids);
  if (!ids) return res.status(400).json({ message: 'Invalid ids' });
  const category = await Category.findOne({
    where: { id: req.body.categoryId ?? 0, UserId: req.userId },
  });
  if (!category) return res.status(404).json({ message: 'Category not found' });

  await Transaction.update(
    { CategoryId: category.id },
    { where: { id: ids, UserId: req.userId, type: category.type } },
  );
  const updated = await Transaction.count({
    where: { id: ids, UserId: req.userId, CategoryId: category.id },
  });
  const owned = await Transaction.count({
    where: { id: ids, UserId: req.userId },
  });
  res.json({ updated, skipped: owned - updated });
});

router.post('/bulk-delete', async (req, res) => {
  const ids = parseIds(req.body.ids);
  if (!ids) return res.status(400).json({ message: 'Invalid ids' });
  const deleted = await Transaction.destroy({
    where: { id: ids, UserId: req.userId },
  });
  res.json({ deleted });
});

// Fire and forget: SMTP latency must not hold up the response, and the check
// never throws.
const alertIfExpense = (userId, tx) => {
  if (tx.type === 'expense') checkBudgetThresholds(userId, tx.CategoryId, tx.date);
};

router.post('/', async (req, res) => {
  const {
    type,
    description,
    categoryId,
    amount,
    date,
    paymentMethod,
    cardId,
    accountId,
  } = req.body;
  const item = await Transaction.create({
    type,
    description,
    amount,
    date,
    paymentMethod,
    UserId: req.userId,
    CategoryId: categoryId || null,
    CardId: cardId || null,
    AccountId: accountId || null,
  });
  alertIfExpense(req.userId, item);
  const full = await Transaction.findByPk(item.id, {
    attributes: { exclude: ['UserId'] },
    include: [
      { model: Category, attributes: { exclude: ['UserId'] } },
      { model: Card, attributes: { exclude: ['UserId'] } },
      { model: Account, attributes: { exclude: ['UserId'] } },
    ],
  });
  res.json(full);
});

router.put('/:id', async (req, res) => {
  const item = await Transaction.findOne({
    where: { id: req.params.id, UserId: req.userId },
  });
  if (!item) return res.status(404).json({ message: 'Not found' });
  const {
    type,
    description,
    categoryId,
    amount,
    date,
    paymentMethod,
    cardId,
    accountId,
  } = req.body;
  await item.update({
    type,
    description,
    amount,
    date,
    paymentMethod,
    CategoryId: categoryId || null,
    CardId: cardId || null,
    AccountId: accountId || null,
  });
  alertIfExpense(req.userId, item);
  const full = await Transaction.findByPk(item.id, {
    attributes: { exclude: ['UserId'] },
    include: [
      { model: Category, attributes: { exclude: ['UserId'] } },
      { model: Card, attributes: { exclude: ['UserId'] } },
      { model: Account, attributes: { exclude: ['UserId'] } },
    ],
  });
  res.json(full);
});

router.delete('/:id', async (req, res) => {
  const item = await Transaction.findOne({
    where: { id: req.params.id, UserId: req.userId },
  });
  if (!item) return res.status(404).json({ message: 'Not found' });
  await item.destroy();
  res.json({ success: true });
});

export default router;
