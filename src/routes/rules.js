import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { sequelize } from '../config/db.js';
import { Category, CategoryRule, Transaction } from '../models/index.js';
import {
  MAX_RULES_PER_USER,
  categoryFits,
  loadRules,
  pickRule,
  ruleMatches,
  validateRule,
} from '../utils/categoryRules.js';

const router = express.Router();
router.use(authMiddleware);

const SAMPLE_SIZE = 10;
const UPDATE_CHUNK = 500;

const ownCategory = (userId, id) =>
  /^\d+$/.test(String(id ?? ''))
    ? Category.findOne({ where: { id, UserId: userId } })
    : null;

const findRule = (userId, id) =>
  /^\d+$/.test(String(id))
    ? CategoryRule.findOne({ where: { id, UserId: userId } })
    : null;

const withCategory = (id) =>
  CategoryRule.findByPk(id, {
    attributes: { exclude: ['UserId'] },
    include: [{ model: Category, attributes: ['id', 'name', 'color', 'type'] }],
  });

router.get('/', async (req, res) => {
  const rules = await CategoryRule.findAll({
    where: { UserId: req.userId },
    attributes: { exclude: ['UserId'] },
    include: [{ model: Category, attributes: ['id', 'name', 'color', 'type'] }],
    order: [
      ['priority', 'ASC'],
      ['id', 'ASC'],
    ],
  });
  res.json(rules);
});

router.post('/', async (req, res) => {
  const { fields, error } = validateRule(req.body);
  if (error) return res.status(400).json(error);
  const category = await ownCategory(req.userId, req.body.categoryId);
  if (!category) {
    return res
      .status(400)
      .json({ code: 'RULE_INVALID_CATEGORY', message: 'Categoría no válida.' });
  }
  const count = await CategoryRule.count({ where: { UserId: req.userId } });
  if (count >= MAX_RULES_PER_USER) {
    return res
      .status(400)
      .json({ code: 'RULE_LIMIT', message: 'Llegaste al máximo de reglas.' });
  }
  // New rules go last; the user moves them up if they should win.
  const last =
    (await CategoryRule.max('priority', { where: { UserId: req.userId } })) ??
    0;
  const rule = await CategoryRule.create({
    ...fields,
    CategoryId: category.id,
    priority: count ? last + 1 : 1,
    UserId: req.userId,
  });
  res.json(await withCategory(rule.id));
});

// Sets the order of all the user's rules: `ids` from highest priority down.
router.put('/order', async (req, res) => {
  const ids = req.body?.ids;
  const own = await CategoryRule.findAll({
    where: { UserId: req.userId },
    attributes: ['id'],
  });
  const ownIds = new Set(own.map((r) => r.id));
  const valid =
    Array.isArray(ids) &&
    ids.length === ownIds.size &&
    new Set(ids).size === ids.length &&
    ids.every((id) => ownIds.has(id));
  if (!valid)
    return res
      .status(400)
      .json({ code: 'RULE_INVALID_ORDER', message: 'Orden no válido.' });
  await sequelize.transaction(async (t) => {
    for (const [index, id] of ids.entries()) {
      await CategoryRule.update(
        { priority: index + 1 },
        { where: { id, UserId: req.userId }, transaction: t },
      );
    }
  });
  res.json({ success: true });
});

// The category the rules would pick for a transaction being typed.
router.post('/match', async (req, res) => {
  const { description, amount, type } = req.body || {};
  if (!['expense', 'income'].includes(type)) return res.json(null);
  const rule = pickRule(await loadRules(req.userId), {
    description,
    amount,
    type,
  });
  res.json(
    rule
      ? { ruleId: rule.id, ruleName: rule.name, categoryId: rule.CategoryId }
      : null,
  );
});

router.put('/:id', async (req, res) => {
  const rule = await findRule(req.userId, req.params.id);
  if (!rule) return res.status(404).json({ message: 'Not found' });
  const { fields, error } = validateRule(req.body, rule.toJSON());
  if (error) return res.status(400).json(error);
  if (req.body.categoryId !== undefined) {
    const category = await ownCategory(req.userId, req.body.categoryId);
    if (!category) {
      return res
        .status(400)
        .json({
          code: 'RULE_INVALID_CATEGORY',
          message: 'Categoría no válida.',
        });
    }
    fields.CategoryId = category.id;
  }
  await rule.update(fields);
  res.json(await withCategory(rule.id));
});

router.delete('/:id', async (req, res) => {
  const rule = await findRule(req.userId, req.params.id);
  if (!rule) return res.status(404).json({ message: 'Not found' });
  await rule.destroy();
  res.json({ success: true });
});

/**
 * Runs one rule over the user's existing transactions. With `dryRun` it only
 * counts. Transactions that already have another category change only with
 * `includeCategorized`, so a category chosen by hand is never lost silently.
 */
router.post('/:id/apply-existing', async (req, res) => {
  const rule = await findRule(req.userId, req.params.id);
  if (!rule) return res.status(404).json({ message: 'Not found' });
  const category = await Category.findByPk(rule.CategoryId);
  const dryRun = req.body?.dryRun !== false;
  const includeCategorized = req.body?.includeCategorized === true;

  const txs = await Transaction.findAll({
    where: { UserId: req.userId },
    attributes: ['id', 'description', 'amount', 'type', 'date', 'CategoryId'],
    include: [{ model: Category, attributes: ['name'] }],
    order: [['date', 'DESC']],
  });
  const matching = txs.filter(
    (tx) =>
      tx.CategoryId !== rule.CategoryId &&
      categoryFits(category, tx.type) &&
      ruleMatches(rule, tx),
  );
  const uncategorized = matching.filter((tx) => !tx.CategoryId);
  const categorized = matching.filter((tx) => tx.CategoryId);
  const toChange = includeCategorized ? matching : uncategorized;

  const summary = {
    uncategorized: uncategorized.length,
    categorized: categorized.length,
    sample: toChange.slice(0, SAMPLE_SIZE).map((tx) => ({
      id: tx.id,
      date: tx.date,
      description: tx.description,
      amount: Number(tx.amount),
      from: tx.Category?.name ?? null,
    })),
  };
  if (dryRun) return res.json({ ...summary, updated: 0 });

  const ids = toChange.map((tx) => tx.id);
  await sequelize.transaction(async (t) => {
    for (let i = 0; i < ids.length; i += UPDATE_CHUNK) {
      await Transaction.update(
        { CategoryId: rule.CategoryId },
        {
          where: { id: ids.slice(i, i + UPDATE_CHUNK), UserId: req.userId },
          transaction: t,
        },
      );
    }
  });
  res.json({ ...summary, updated: ids.length });
});

export default router;
