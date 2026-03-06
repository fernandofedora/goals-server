import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { Category } from '../models/index.js';

const router = express.Router();
router.use(authMiddleware);

router.get('/', async (req, res) => {
  let items = await Category.findAll({ where: { UserId: req.userId }, attributes: { exclude: ['UserId'] } });

  if (items.length === 0) {
    try {
      const defaults = [
        { name: 'Housing', color: '#8b5cf6', type: 'expense' },
        { name: 'Food', color: '#f59e0b', type: 'expense' },
        { name: 'Transportation', color: '#3b82f6', type: 'expense' },
        { name: 'Utilities', color: '#06b6d4', type: 'expense' },
        { name: 'Entertainment', color: '#ec4899', type: 'expense' },
        { name: 'Healthcare', color: '#10b981', type: 'expense' },
        { name: 'Salary', color: '#10b981', type: 'income' }
      ];

      await Promise.all(
        defaults.map(def =>
          Category.findOrCreate({
            where: { name: def.name, type: def.type, UserId: req.userId },
            defaults: { color: def.color, UserId: req.userId }
          })
        )
      );
    } catch (error) {
      console.error('Failed to create default categories:', error);
    }
    items = await Category.findAll({ where: { UserId: req.userId }, attributes: { exclude: ['UserId'] } });
  }

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
