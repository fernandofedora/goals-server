import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { col, fn } from 'sequelize';
import { Card, Transaction } from '../models/index.js';

const router = express.Router();
router.use(authMiddleware);

const monthKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

// Expenses per month for every card, plus the change against last month.
router.get('/history', async (req, res) => {
  const months = Math.min(
    Math.max(parseInt(req.query.months, 10) || 12, 1),
    36,
  );
  const cards = await Card.findAll({ where: { UserId: req.userId } });
  if (cards.length === 0) return res.json([]);

  const monthExpr = fn('DATE_FORMAT', col('date'), '%Y-%m');
  const rows = await Transaction.findAll({
    attributes: [
      'CardId',
      [monthExpr, 'month'],
      [fn('SUM', col('amount')), 'total'],
    ],
    where: {
      UserId: req.userId,
      CardId: cards.map((c) => c.id),
      type: 'expense',
    },
    group: ['CardId', monthExpr],
    raw: true,
  });

  const now = new Date();
  const keys = Array.from({ length: months + 1 }, (_, i) =>
    monthKey(new Date(now.getFullYear(), now.getMonth() - (months - i), 1)),
  );

  res.json(
    cards.map((card) => {
      const cents = new Map(
        rows
          .filter((r) => r.CardId === card.id)
          .map((r) => [r.month, Math.round(Number(r.total) * 100)]),
      );
      const at = (key) => cents.get(key) || 0;
      const current = at(keys[months]);
      return {
        cardId: card.id,
        spentThisMonth: current / 100,
        delta: (current - at(keys[months - 1])) / 100,
        history: keys
          .slice(1)
          .map((month) => ({ month, spent: at(month) / 100 })),
      };
    }),
  );
});

router.get('/', async (req, res) => {
  const items = await Card.findAll({
    where: { UserId: req.userId },
    attributes: { exclude: ['UserId'] },
  });
  res.json(items);
});

router.post('/', async (req, res) => {
  const { name, color, last4 } = req.body;
  const item = await Card.create({ name, color, last4, UserId: req.userId });
  const plain = item.toJSON();
  delete plain.UserId;
  res.json(plain);
});

router.put('/:id', async (req, res) => {
  const item = await Card.findOne({
    where: { id: req.params.id, UserId: req.userId },
  });
  if (!item) return res.status(404).json({ message: 'Not found' });
  const { name, color, last4 } = req.body;
  await item.update({ name, color, last4 });
  const plain = item.toJSON();
  delete plain.UserId;
  res.json(plain);
});

router.delete('/:id', async (req, res) => {
  const item = await Card.findOne({
    where: { id: req.params.id, UserId: req.userId },
  });
  if (!item) return res.status(404).json({ message: 'Not found' });
  await item.destroy();
  res.json({ success: true });
});

export default router;
