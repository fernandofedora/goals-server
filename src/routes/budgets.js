import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { Budget } from '../models/index.js';

const router = express.Router();
router.use(authMiddleware);

router.get('/', async (req, res) => {
  const items = await Budget.findAll({ where: { UserId: req.userId } });
  res.json(items);
});

router.post('/', async (req, res) => {
  const { month, year, amount } = req.body;
  const item = await Budget.create({ month, year, amount, UserId: req.userId });
  res.json(item);
});

router.delete('/:id', async (req, res) => {
  const item = await Budget.findOne({ where: { id: req.params.id, UserId: req.userId } });
  if (!item) return res.status(404).json({ message: 'Not found' });
  await item.destroy();
  res.json({ success: true });
});

export default router;