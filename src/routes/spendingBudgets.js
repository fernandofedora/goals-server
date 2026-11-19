import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { sequelize } from '../config/db.js';
import { SpendingBudget } from '../models/index.js';
import {
  MAX_BUDGETS,
  budgetDetail,
  budgetStatuses,
  loadBudgets,
  validateBudget,
} from '../services/spendingBudgets.js';

const router = express.Router();
router.use(authMiddleware);

const findBudget = (userId, id) =>
  /^\d+$/.test(String(id))
    ? SpendingBudget.findOne({ where: { id, UserId: userId } })
    : null;

const current = async (budget) => {
  const [full] = await loadBudgets(budget.UserId, { id: budget.id });
  return {
    ...full.toJSON(),
    categoryIds: full.Categories.map((c) => c.id),
    tagIds: full.Tags.map((t) => t.id),
  };
};

// Every budget with its running period: spent, carry-over, available.
router.get('/', async (req, res) => {
  try {
    res.json(await budgetStatuses(req.userId));
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/', async (req, res) => {
  const count = await SpendingBudget.count({ where: { UserId: req.userId } });
  if (count >= MAX_BUDGETS) {
    return res.status(400).json({
      code: 'BUDGET_LIMIT',
      message: 'Llegaste al máximo de presupuestos.',
    });
  }
  const checked = await validateBudget(req.userId, req.body);
  if (checked.error) return res.status(400).json(checked.error);
  const budget = await sequelize.transaction(async (t) => {
    const created = await SpendingBudget.create(
      { ...checked.fields, UserId: req.userId },
      { transaction: t },
    );
    await created.setCategories(checked.categories, { transaction: t });
    await created.setTags(checked.tags, { transaction: t });
    return created;
  });
  res.json(await current(budget));
});

router.put('/:id', async (req, res) => {
  const budget = await findBudget(req.userId, req.params.id);
  if (!budget) return res.status(404).json({ message: 'Not found' });
  const checked = await validateBudget(
    req.userId,
    req.body,
    await current(budget),
  );
  if (checked.error) return res.status(400).json(checked.error);
  await sequelize.transaction(async (t) => {
    await budget.update(checked.fields, { transaction: t });
    await budget.setCategories(checked.categories, { transaction: t });
    await budget.setTags(checked.tags, { transaction: t });
  });
  res.json(await current(budget));
});

router.delete('/:id', async (req, res) => {
  const budget = await findBudget(req.userId, req.params.id);
  if (!budget) return res.status(404).json({ message: 'Not found' });
  await budget.destroy();
  res.json({ success: true });
});

// Old links pointed at a category (/transactions/budget/:categoryId). Finds the
// budget migrated from it, or else one whose only scope is that category.
router.get('/by-category/:categoryId', async (req, res) => {
  const categoryId = Number(req.params.categoryId);
  if (!Number.isInteger(categoryId) || categoryId <= 0) {
    return res.status(404).json({ message: 'Not found' });
  }
  const budgets = await loadBudgets(req.userId);
  const match =
    budgets.find((b) => b.migratedFromCategoryId === categoryId) ||
    budgets.find(
      (b) =>
        !b.isCatchAll &&
        !b.Tags.length &&
        b.Categories.length === 1 &&
        b.Categories[0].id === categoryId,
    );
  if (!match) return res.status(404).json({ message: 'Not found' });
  res.json({
    id: match.id,
    periodType: match.periodType,
    startDay: match.startDay,
  });
});

// Day-by-day view of one period; offset 0 is the running one, -1 the previous…
router.get('/:id/detail', async (req, res) => {
  const offset = Number(req.query.offset ?? 0);
  if (!Number.isInteger(offset) || offset > 0 || offset < -60) {
    return res.status(400).json({ message: 'Invalid offset' });
  }
  try {
    const detail = await budgetDetail(req.userId, req.params.id, offset);
    if (!detail) return res.status(404).json({ message: 'Not found' });
    res.json(detail);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;
