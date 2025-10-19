import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { Card } from '../models/index.js';

const router = express.Router();
router.use(authMiddleware);

router.get('/', async (req, res) => {
  const items = await Card.findAll({ where: { UserId: req.userId } });
  res.json(items);
});

router.post('/', async (req, res) => {
  const { name, color, last4 } = req.body;
  const item = await Card.create({ name, color, last4, UserId: req.userId });
  res.json(item);
});

router.put('/:id', async (req, res) => {
  const item = await Card.findOne({ where: { id: req.params.id, UserId: req.userId } });
  if (!item) return res.status(404).json({ message: 'Not found' });
  const { name, color, last4 } = req.body;
  await item.update({ name, color, last4 });
  res.json(item);
});

router.delete('/:id', async (req, res) => {
  const item = await Card.findOne({ where: { id: req.params.id, UserId: req.userId } });
  if (!item) return res.status(404).json({ message: 'Not found' });
  await item.destroy();
  res.json({ success: true });
});

export default router;