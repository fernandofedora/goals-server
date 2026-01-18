import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { Transaction, Category, Card } from '../models/index.js';

const router = express.Router();
router.use(authMiddleware);

router.get('/', async (req, res) => {
  const { cardId, page, limit } = req.query;
  const where = { UserId: req.userId };
  if (cardId) where.CardId = cardId;

  const commonOptions = {
    where,
    attributes: { exclude: ['UserId'] },
    include: [
      { model: Category, attributes: { exclude: ['UserId'] } },
      { model: Card, attributes: { exclude: ['UserId'] } }
    ],
    order: [['date','DESC']]
  };

  const hasPagination = page !== undefined || limit !== undefined;

  if (hasPagination) {
    const pageInt = Math.max(parseInt(page || '1', 10), 1);
    const limitInt = Math.max(parseInt(limit || '20', 10), 1);
    const offset = (pageInt - 1) * limitInt;
    const { rows, count } = await Transaction.findAndCountAll({
      ...commonOptions,
      offset,
      limit: limitInt
    });
    res.json({ items: rows, page: pageInt, limit: limitInt, total: count });
    return;
  }

  const items = await Transaction.findAll(commonOptions);
  res.json(items);
});

router.post('/', async (req, res) => {
  const { type, description, categoryId, amount, date, paymentMethod, cardId } = req.body;
  const item = await Transaction.create({ type, description, amount, date, paymentMethod, UserId: req.userId, CategoryId: categoryId || null, CardId: cardId || null });
  const full = await Transaction.findByPk(item.id, {
    attributes: { exclude: ['UserId'] },
    include: [
      { model: Category, attributes: { exclude: ['UserId'] } },
      { model: Card, attributes: { exclude: ['UserId'] } }
    ]
  });
  res.json(full);
});

router.put('/:id', async (req, res) => {
  const item = await Transaction.findOne({ where: { id: req.params.id, UserId: req.userId } });
  if (!item) return res.status(404).json({ message: 'Not found' });
  const { type, description, categoryId, amount, date, paymentMethod, cardId } = req.body;
  await item.update({ type, description, amount, date, paymentMethod, CategoryId: categoryId || null, CardId: cardId || null });
  const full = await Transaction.findByPk(item.id, {
    attributes: { exclude: ['UserId'] },
    include: [
      { model: Category, attributes: { exclude: ['UserId'] } },
      { model: Card, attributes: { exclude: ['UserId'] } }
    ]
  });
  res.json(full);
});

router.delete('/:id', async (req, res) => {
  const item = await Transaction.findOne({ where: { id: req.params.id, UserId: req.userId } });
  if (!item) return res.status(404).json({ message: 'Not found' });
  await item.destroy();
  res.json({ success: true });
});

export default router;
