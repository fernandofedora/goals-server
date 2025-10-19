import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { Transaction, Category, Card } from '../models/index.js';

const router = express.Router();
router.use(authMiddleware);

router.get('/', async (req, res) => {
  const items = await Transaction.findAll({ where: { UserId: req.userId }, include: [Category, Card], order: [['date','DESC']] });
  res.json(items);
});

router.post('/', async (req, res) => {
  const { type, description, categoryId, amount, date, paymentMethod, cardId } = req.body;
  const item = await Transaction.create({ type, description, amount, date, paymentMethod, UserId: req.userId, CategoryId: categoryId || null, CardId: cardId || null });
  const full = await Transaction.findByPk(item.id, { include: [Category, Card] });
  res.json(full);
});

router.put('/:id', async (req, res) => {
  const item = await Transaction.findOne({ where: { id: req.params.id, UserId: req.userId } });
  if (!item) return res.status(404).json({ message: 'Not found' });
  const { type, description, categoryId, amount, date, paymentMethod, cardId } = req.body;
  await item.update({ type, description, amount, date, paymentMethod, CategoryId: categoryId || null, CardId: cardId || null });
  const full = await Transaction.findByPk(item.id, { include: [Category, Card] });
  res.json(full);
});

router.delete('/:id', async (req, res) => {
  const item = await Transaction.findOne({ where: { id: req.params.id, UserId: req.userId } });
  if (!item) return res.status(404).json({ message: 'Not found' });
  await item.destroy();
  res.json({ success: true });
});

export default router;