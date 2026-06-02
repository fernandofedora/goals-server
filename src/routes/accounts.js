import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { Account } from '../models/index.js';

const router = express.Router();
router.use(authMiddleware);

// GET all accounts
router.get('/', async (req, res) => {
  const items = await Account.findAll({ where: { UserId: req.userId } });
  res.json(items);
});

// POST a new account
router.post('/', async (req, res) => {
  const { name, color, initialBalance, isExcludedFromTotals } = req.body;
  if (!name) return res.status(400).json({ message: 'Name is required' });
  const item = await Account.create({ name, color, initialBalance: initialBalance || 0, isExcludedFromTotals: !!isExcludedFromTotals, UserId: req.userId });
  res.status(201).json(item);
});

// PUT (update) an account
router.put('/:id', async (req, res) => {
  const item = await Account.findOne({ where: { id: req.params.id, UserId: req.userId } });
  if (!item) return res.status(404).json({ message: 'Not found' });
  const { name, color, initialBalance, isExcludedFromTotals } = req.body;
  const fields = { name, color, initialBalance };
  if (isExcludedFromTotals !== undefined) fields.isExcludedFromTotals = !!isExcludedFromTotals;
  await item.update(fields);
  res.json(item);
});

// DELETE an account
router.delete('/:id', async (req, res) => {
  const item = await Account.findOne({ where: { id: req.params.id, UserId: req.userId } });
  if (!item) return res.status(404).json({ message: 'Not found' });
  await item.destroy();
  res.status(204).send();
});

export default router;
