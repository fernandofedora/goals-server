import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { col, fn } from 'sequelize';
import { Account, Transaction } from '../models/index.js';

const router = express.Router();
router.use(authMiddleware);

const monthKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

// Closing balance of every account for the last N months, plus the change in
// the current month. Summed in cents so running totals don't drift.
router.get('/history', async (req, res) => {
  const months = Math.min(
    Math.max(parseInt(req.query.months, 10) || 12, 1),
    36,
  );
  const accounts = await Account.findAll({ where: { UserId: req.userId } });
  if (accounts.length === 0) return res.json([]);

  const monthExpr = fn('DATE_FORMAT', col('date'), '%Y-%m');
  const rows = await Transaction.findAll({
    attributes: [
      'AccountId',
      'type',
      [monthExpr, 'month'],
      [fn('SUM', col('amount')), 'total'],
    ],
    where: { UserId: req.userId, AccountId: accounts.map((a) => a.id) },
    group: ['AccountId', 'type', monthExpr],
    raw: true,
  });

  const now = new Date();
  const window = Array.from({ length: months }, (_, i) =>
    monthKey(new Date(now.getFullYear(), now.getMonth() - (months - 1 - i), 1)),
  );
  const toAmount = (cents) => cents / 100;

  res.json(
    accounts.map((account) => {
      const net = new Map();
      for (const r of rows.filter((row) => row.AccountId === account.id)) {
        const cents = Math.round(Number(r.total) * 100);
        net.set(
          r.month,
          (net.get(r.month) || 0) + (r.type === 'income' ? cents : -cents),
        );
      }

      const initial = Math.round(Number(account.initialBalance || 0) * 100);
      let opening = initial;
      for (const [month, cents] of net) if (month < window[0]) opening += cents;

      let running = opening;
      const closings = window.map((month) => (running += net.get(month) || 0));
      const previous =
        closings.length > 1 ? closings[closings.length - 2] : opening;
      const allNet = [...net.values()].reduce((sum, cents) => sum + cents, 0);

      return {
        accountId: account.id,
        // Includes future-dated rows, like the balance shown on the Dashboard.
        balance: toAmount(initial + allNet),
        delta: toAmount(closings[closings.length - 1] - previous),
        history: window.map((month, i) => ({
          month,
          balance: toAmount(closings[i]),
        })),
      };
    }),
  );
});

// GET all accounts
router.get('/', async (req, res) => {
  const items = await Account.findAll({ where: { UserId: req.userId } });
  res.json(items);
});

// POST a new account
router.post('/', async (req, res) => {
  const { name, color, initialBalance, isExcludedFromTotals } = req.body;
  if (!name) return res.status(400).json({ message: 'Name is required' });
  const item = await Account.create({
    name,
    color,
    initialBalance: initialBalance || 0,
    isExcludedFromTotals: !!isExcludedFromTotals,
    UserId: req.userId,
  });
  res.status(201).json(item);
});

// PUT (update) an account
router.put('/:id', async (req, res) => {
  const item = await Account.findOne({
    where: { id: req.params.id, UserId: req.userId },
  });
  if (!item) return res.status(404).json({ message: 'Not found' });
  const { name, color, initialBalance, isExcludedFromTotals } = req.body;
  const fields = { name, color, initialBalance };
  if (isExcludedFromTotals !== undefined)
    fields.isExcludedFromTotals = !!isExcludedFromTotals;
  await item.update(fields);
  res.json(item);
});

// DELETE an account
router.delete('/:id', async (req, res) => {
  const item = await Account.findOne({
    where: { id: req.params.id, UserId: req.userId },
  });
  if (!item) return res.status(404).json({ message: 'Not found' });
  await item.destroy();
  res.status(204).send();
});

export default router;
