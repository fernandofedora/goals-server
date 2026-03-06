import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { Category } from '../models/index.js';

const router = express.Router();
router.use(authMiddleware);

router.get('/', async (req, res) => {
  const items = await Category.findAll({ where: { UserId: req.userId }, attributes: { exclude: ['UserId'] } });
  res.json(items);
});

router.post('/', async (req, res) => {
  const { name, color, type } = req.body;
  const item = await Category.create({ name, color, type, UserId: req.userId });
  const plain = item.toJSON();
  delete plain.UserId;
  res.json(plain);
});

router.put('/:id', async (req, res) => {
  const item = await Category.findOne({ where: { id: req.params.id, UserId: req.userId } });
  if (!item) return res.status(404).json({ message: 'Not found' });
  const { name, color, type } = req.body;
  await item.update({ name, color, type });
  const plain = item.toJSON();
  delete plain.UserId;
  res.json(plain);
});

router.delete('/:id', async (req, res) => {
  const item = await Category.findOne({ where: { id: req.params.id, UserId: req.userId } });
  if (!item) return res.status(404).json({ message: 'Not found' });
  await item.destroy();
  res.json({ success: true });
});

export default router;
