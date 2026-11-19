import express from 'express';
import { Op, col, fn } from 'sequelize';
import { authMiddleware } from '../middleware/auth.js';
import { withChildIds } from '../utils/categoryTree.js';
import { checkBudgetThresholds } from '../services/budgetAlerts.js';
import { applyRules, categoryFits } from '../utils/categoryRules.js';
import { sequelize } from '../config/db.js';
import {
  Transaction,
  Category,
  Card,
  Account,
  Tag,
  TransactionTag,
} from '../models/index.js';

const router = express.Router();
router.use(authMiddleware);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TAGS_PER_TX = 10;

const TAG_INCLUDE = {
  model: Tag,
  attributes: ['id', 'name', 'color'],
  through: { attributes: [] },
};

/**
 * The user's tags named in `tagIds`. undefined = not sent (leave the tags
 * alone); anything that is not a list of the user's own tag ids is an error.
 */
async function resolveTags(userId, tagIds) {
  if (tagIds === undefined) return { tags: null };
  const valid =
    Array.isArray(tagIds) &&
    tagIds.length <= MAX_TAGS_PER_TX &&
    tagIds.every((id) => Number.isInteger(id) && id > 0);
  if (!valid) return { error: true };
  const unique = [...new Set(tagIds)];
  const tags = unique.length
    ? await Tag.findAll({ where: { id: unique, UserId: userId } })
    : [];
  return tags.length === unique.length ? { tags } : { error: true };
}
const tagError = (res) =>
  res.status(400).json({ code: 'TAGS_INVALID', message: 'Etiquetas no válidas' });
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

// Transfers between own accounts. In the general history they stay listed but
// leave the income/expense totals (like the dashboard); in one account's or
// card's history they count, so the totals match its balance.
async function splitTransfers(where, userId, keepInTotals) {
  const transferCats = await Category.findAll({
    where: { UserId: userId, type: 'transfer' },
    attributes: ['id'],
  });
  const ids = transferCats.map((c) => c.id);
  if (ids.length === 0) return { totalsWhere: where, transfers: null };
  const only = (cond) => ({ ...where, [Op.and]: [...(where[Op.and] || []), cond] });
  const legs = await filteredTotals(only({ CategoryId: ids }));
  if (legs.income === 0 && legs.expense === 0) {
    return { totalsWhere: where, transfers: null };
  }
  return {
    totalsWhere: keepInTotals
      ? where
      : only({ [Op.or]: [{ CategoryId: null }, { CategoryId: { [Op.notIn]: ids } }] }),
    transfers: { in: legs.income, out: legs.expense, inTotals: keepInTotals },
  };
}

router.get('/', async (req, res) => {
  const { cardId, accountId, page, limit } = req.query;
  const { where, error } = buildFilters(req.query, req.userId);
  if (error) return res.status(400).json({ message: `Invalid ${error}` });
  // A parent category also lists the transactions of its subcategories.
  if (req.query.categoryId) {
    where.CategoryId = await withChildIds(req.userId, req.query.categoryId);
  }
  if (req.query.tagId) {
    if (!/^\d+$/.test(String(req.query.tagId))) {
      return res.status(400).json({ message: 'Invalid tagId' });
    }
    const tag = await Tag.findOne({
      where: { id: req.query.tagId, UserId: req.userId },
    });
    const links = tag
      ? await TransactionTag.findAll({
          where: { TagId: tag.id },
          attributes: ['TransactionId'],
          raw: true,
        })
      : [];
    where.id = links.map((l) => l.TransactionId);
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
      TAG_INCLUDE,
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
      // Tags join several rows per transaction; count transactions, not joins.
      distinct: true,
      col: 'id',
      offset,
      limit: limitInt,
    });
    const dates = [...new Set(rows.map((r) => r.date))];
    const { totalsWhere, transfers } = await splitTransfers(
      where,
      req.userId,
      Boolean(accountId || cardId),
    );
    const [totals, dayTotals] = await Promise.all([
      filteredTotals(totalsWhere),
      netPerDay(totalsWhere, dates),
    ]);
    res.json({
      items: rows,
      page: pageInt,
      limit: limitInt,
      total: count,
      totals,
      dayTotals,
      transfers,
    });
    return;
  }

  const items = await Transaction.findAll(commonOptions);
  res.json(items);
});

// Inbox of transactions without a category: how many and the next ones to sort.
router.get('/uncategorized', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const where = { UserId: req.userId, CategoryId: null };
  const [count, items] = await Promise.all([
    Transaction.count({ where }),
    Transaction.findAll({
      where,
      attributes: ['id', 'date', 'description', 'amount', 'type', 'paymentMethod'],
      include: [
        { model: Card, attributes: ['id', 'name'] },
        { model: Account, attributes: ['id', 'name'] },
      ],
      order: [
        ['date', 'DESC'],
        ['id', 'DESC'],
      ],
      limit,
    }),
  ]);
  res.json({ count, items });
});

// Only rows of the same type as the category change (any type for a transfer
// category); the rest are reported.
router.patch('/bulk', async (req, res) => {
  const ids = parseIds(req.body.ids);
  if (!ids) return res.status(400).json({ message: 'Invalid ids' });
  const category = await Category.findOne({
    where: { id: req.body.categoryId ?? 0, UserId: req.userId },
  });
  if (!category) return res.status(404).json({ message: 'Category not found' });

  // A transfer category fits both legs (expense out, income in).
  const typeMatch = category.type === 'transfer' ? {} : { type: category.type };
  await Transaction.update(
    { CategoryId: category.id },
    { where: { id: ids, UserId: req.userId, ...typeMatch } },
  );
  const updated = await Transaction.count({
    where: { id: ids, UserId: req.userId, CategoryId: category.id },
  });
  const owned = await Transaction.count({
    where: { id: ids, UserId: req.userId },
  });
  res.json({ updated, skipped: owned - updated });
});

/**
 * Ids to delete so no split is left half: a part brings its container and its
 * sibling parts along. Returns how many visible transactions go.
 */
async function deleteWithSplits(userId, ids) {
  const any = Transaction.unscoped();
  const rows = await any.findAll({ where: { id: ids, UserId: userId }, attributes: ['id', 'splitOfId'] });
  const containers = [...new Set(rows.map((r) => r.splitOfId).filter(Boolean))];
  const siblings = containers.length
    ? await any.findAll({ where: { splitOfId: containers, UserId: userId }, attributes: ['id'] })
    : [];
  const visible = new Set([...rows.map((r) => r.id), ...siblings.map((r) => r.id)]);
  await sequelize.transaction(async (t) => {
    await any.destroy({ where: { id: [...visible, ...containers], UserId: userId }, transaction: t });
  });
  return visible.size;
}

router.post('/bulk-delete', async (req, res) => {
  const ids = parseIds(req.body.ids);
  if (!ids) return res.status(400).json({ message: 'Invalid ids' });
  res.json({ deleted: await deleteWithSplits(req.userId, ids) });
});

// Fire and forget: SMTP latency must not hold up the response, and the check
// never throws.
const alertIfExpense = (userId, tx, tagIds = []) => {
  if (tx.type === 'expense') {
    checkBudgetThresholds(userId, tx.CategoryId, tx.date, undefined, tagIds);
  }
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
  const { tags, error: badTags } = await resolveTags(req.userId, req.body.tagIds);
  if (badTags) return tagError(res);
  // Without a category, the user's rules may pick one.
  const ruledCategoryId = categoryId
    ? null
    : await applyRules(req.userId, { description, amount, type });
  const item = await Transaction.create({
    type,
    description,
    amount,
    date,
    paymentMethod,
    UserId: req.userId,
    CategoryId: categoryId || ruledCategoryId,
    CardId: cardId || null,
    AccountId: accountId || null,
  });
  if (tags?.length) await item.setTags(tags);
  alertIfExpense(req.userId, item, (tags ?? []).map((tag) => tag.id));
  const full = await Transaction.findByPk(item.id, {
    attributes: { exclude: ['UserId'] },
    include: [
      { model: Category, attributes: { exclude: ['UserId'] } },
      { model: Card, attributes: { exclude: ['UserId'] } },
      { model: Account, attributes: { exclude: ['UserId'] } },
      TAG_INCLUDE,
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
  if (item.splitOfId) {
    const locked =
      cents(amount) !== cents(item.amount) ||
      date !== item.date ||
      type !== item.type ||
      paymentMethod !== item.paymentMethod ||
      (cardId || null) !== (item.CardId || null) ||
      (accountId || null) !== (item.AccountId || null);
    if (locked) {
      return res.status(409).json({
        code: 'SPLIT_PART_LOCKED',
        message: 'Es parte de una división: cambia el monto, la fecha o la cuenta desde "Editar división".',
      });
    }
  }
  const { tags, error: badTags } = await resolveTags(req.userId, req.body.tagIds);
  if (badTags) return tagError(res);
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
  if (tags) await item.setTags(tags);
  alertIfExpense(req.userId, item, (tags ?? []).map((tag) => tag.id));
  const full = await Transaction.findByPk(item.id, {
    attributes: { exclude: ['UserId'] },
    include: [
      { model: Category, attributes: { exclude: ['UserId'] } },
      { model: Card, attributes: { exclude: ['UserId'] } },
      { model: Account, attributes: { exclude: ['UserId'] } },
      TAG_INCLUDE,
    ],
  });
  res.json(full);
});

router.delete('/:id', async (req, res) => {
  const item = await Transaction.findOne({
    where: { id: req.params.id, UserId: req.userId },
  });
  if (!item) return res.status(404).json({ message: 'Not found' });
  const deleted = await deleteWithSplits(req.userId, [item.id]);
  res.json({ success: true, deleted });
});

// ── Split transactions ──────────────────────────────────────────────────────
const MAX_PARTS = 20;
const cents = (n) => Math.round(Number(n) * 100);
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** The container of a split, or of the transaction that would become one. */
async function findSplitRoot(userId, id) {
  if (!/^\d+$/.test(String(id))) return null;
  const item = await Transaction.unscoped().findOne({ where: { id, UserId: userId } });
  if (!item || !item.splitOfId) return item;
  return Transaction.unscoped().findOne({ where: { id: item.splitOfId, UserId: userId } });
}

const loadParts = (container) =>
  Transaction.findAll({
    where: { splitOfId: container.id, UserId: container.UserId },
    attributes: { exclude: ['UserId'] },
    include: [{ model: Category, attributes: ['id', 'name', 'color', 'type'] }, TAG_INCLUDE],
    order: [['id', 'ASC']],
  });

const splitView = async (container) => ({
  original: {
    id: container.id,
    description: container.description,
    amount: Number(container.amount),
    date: container.date,
    type: container.type,
    categoryId: container.CategoryId,
    isSplit: container.isSplitContainer,
  },
  parts: container.isSplitContainer ? await loadParts(container) : [],
});

/**
 * Checks the parts of a split. They must be 2 to 20, each with an amount above
 * 0 (2 decimals) and one of the user's categories that fits the type, and add
 * up exactly to the original.
 */
async function validateParts(userId, container, parts) {
  if (!Array.isArray(parts) || parts.length < 2 || parts.length > MAX_PARTS) {
    return { error: 'SPLIT_PART_COUNT' };
  }
  const categoryIds = [...new Set(parts.map((p) => Number(p.categoryId)))];
  const categories = await Category.findAll({ where: { id: categoryIds, UserId: userId } });
  const clean = [];
  for (const p of parts) {
    const amount = Number(p.amount);
    if (!Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) {
      return { error: 'SPLIT_PART_AMOUNT' };
    }
    const category = categories.find((c) => c.id === Number(p.categoryId));
    if (!category || !categoryFits(category, container.type)) return { error: 'SPLIT_PART_CATEGORY' };
    const description = String(p.description ?? '').replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
    if (description.length > 255) return { error: 'SPLIT_PART_DESCRIPTION' };
    const tags = await resolveTags(userId, p.tagIds);
    if (tags.error) return { error: 'TAGS_INVALID' };
    clean.push({ amount: cents(amount) / 100, category, description: description || container.description, tags: tags.tags });
  }
  const total = clean.reduce((sum, p) => sum + cents(p.amount), 0);
  if (total !== cents(container.amount)) return { error: 'SPLIT_SUM_MISMATCH', total: total / 100 };
  return { parts: clean };
}

const SPLIT_MESSAGES = {
  SPLIT_PART_COUNT: 'Divide en 2 a 20 partes.',
  SPLIT_PART_AMOUNT: 'Cada parte necesita un monto mayor que 0 con hasta 2 decimales.',
  SPLIT_PART_CATEGORY: 'Cada parte necesita una de tus categorías del mismo tipo.',
  SPLIT_PART_DESCRIPTION: 'La descripción de una parte tiene hasta 255 caracteres.',
  SPLIT_SUM_MISMATCH: 'Las partes deben sumar exactamente el total.',
  TAGS_INVALID: 'Etiquetas no válidas',
};

router.get('/:id/split', async (req, res) => {
  const container = await findSplitRoot(req.userId, req.params.id);
  if (!container) return res.status(404).json({ message: 'Not found' });
  res.json(await splitView(container));
});

// Splits a transaction, or replaces the parts of one already split.
router.put('/:id/split', async (req, res) => {
  const container = await findSplitRoot(req.userId, req.params.id);
  if (!container) return res.status(404).json({ message: 'Not found' });
  const checked = await validateParts(req.userId, container, req.body?.parts);
  if (checked.error) {
    return res.status(400).json({ code: checked.error, message: SPLIT_MESSAGES[checked.error], total: checked.total });
  }
  await sequelize.transaction(async (t) => {
    // Parts inherit the tags: from the original on a first split, from the
    // current parts when the split is edited.
    const inherited = container.isSplitContainer
      ? [
          ...new Map(
            (await loadParts(container))
              .flatMap((p) => p.Tags || [])
              .map((tag) => [tag.id, tag]),
          ).values(),
        ]
      : await container.getTags({ transaction: t });
    await Transaction.destroy({ where: { splitOfId: container.id, UserId: req.userId }, transaction: t });
    await container.update({ isSplitContainer: true, CategoryId: null }, { transaction: t });
    await container.setTags([], { transaction: t });
    for (const p of checked.parts) {
      const part = await Transaction.create(
        {
          UserId: req.userId,
          splitOfId: container.id,
          type: container.type,
          date: container.date,
          paymentMethod: container.paymentMethod,
          AccountId: container.AccountId,
          CardId: container.CardId,
          importBatchId: container.importBatchId,
          description: p.description,
          amount: p.amount,
          CategoryId: p.category.id,
        },
        { transaction: t },
      );
      const tags = p.tags ?? inherited;
      if (tags.length) await part.setTags(tags, { transaction: t });
    }
  });
  const fresh = await Transaction.unscoped().findByPk(container.id);
  for (const p of checked.parts) {
    if (container.type === 'expense') checkBudgetThresholds(req.userId, p.category.id, container.date);
  }
  res.json(await splitView(fresh));
});

// Joins a split back into one transaction, with the first part's category.
router.delete('/:id/split', async (req, res) => {
  const container = await findSplitRoot(req.userId, req.params.id);
  if (!container) return res.status(404).json({ message: 'Not found' });
  if (!container.isSplitContainer) return res.status(400).json({ code: 'SPLIT_NOT_SPLIT', message: 'No está dividida.' });
  const parts = await loadParts(container);
  const tagIds = [...new Set(parts.flatMap((p) => (p.Tags || []).map((tag) => tag.id)))];
  await sequelize.transaction(async (t) => {
    await Transaction.destroy({ where: { splitOfId: container.id, UserId: req.userId }, transaction: t });
    await container.update({ isSplitContainer: false, CategoryId: parts[0]?.CategoryId ?? null }, { transaction: t });
    if (tagIds.length) await container.setTags(tagIds, { transaction: t });
  });
  res.json(await splitView(await Transaction.findByPk(container.id)));
});

export default router;
