import express from 'express';
import { Op } from 'sequelize';
import { authMiddleware } from '../middleware/auth.js';
import {
  ScheduledPayment,
  Category,
  Card,
  Account,
  Transaction,
} from '../models/index.js';

const router = express.Router();
router.use(authMiddleware);

// @route   POST api/scheduled-payments
// @desc    Create a scheduled payment
// @access  Private
router.post('/', async (req, res) => {
  const {
    name,
    type,
    amount,
    period,
    CardId,
    AccountId,
    paymentMethod,
    CategoryId,
    description,
    startDate,
    endDate,
    occurrences,
    specificDay,
  } = req.body;

  try {
    // Simple validation
    if (
      !name ||
      !type ||
      !amount ||
      !period ||
      !CategoryId ||
      !startDate ||
      !paymentMethod ||
      !endDate
    ) {
      return res.status(400).json({ msg: 'Please enter all required fields' });
    }
    if (paymentMethod === 'card' && !CardId) {
      return res
        .status(400)
        .json({ msg: 'Credit card is required when payment method is card' });
    }
    if (paymentMethod === 'account' && !AccountId) {
      return res
        .status(400)
        .json({
          msg: 'Bank account is required when payment method is account',
        });
    }

    const newScheduledPayment = await ScheduledPayment.create({
      UserId: req.userId,
      name,
      type,
      amount,
      period,
      CardId: paymentMethod === 'card' ? CardId : null,
      AccountId: paymentMethod === 'account' ? AccountId : null,
      paymentMethod,
      CategoryId,
      description,
      startDate,
      endDate,
      occurrences,
      specificDay,
      nextDueDate: startDate,
    });

    res.json(newScheduledPayment);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   GET api/scheduled-payments
// @desc    Get all scheduled payments for a user
// @access  Private
router.get('/', async (req, res) => {
  try {
    const scheduledPayments = await ScheduledPayment.findAll({
      where: { UserId: req.userId },
      include: [Category, Card, Account],
    });
    res.json(scheduledPayments);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   PUT api/scheduled-payments/:id
// @desc    Update a scheduled payment
// @access  Private
router.put('/:id', async (req, res) => {
  const {
    name,
    type,
    amount,
    period,
    CardId,
    AccountId,
    paymentMethod,
    CategoryId,
    description,
    startDate,
    endDate,
    occurrences,
    specificDay,
    status,
  } = req.body;

  try {
    let scheduledPayment = await ScheduledPayment.findByPk(req.params.id);

    if (!scheduledPayment)
      return res.status(404).json({ msg: 'Scheduled payment not found' });

    if (paymentMethod === 'card' && !CardId) {
      return res
        .status(400)
        .json({ msg: 'Credit card is required when payment method is card' });
    }
    if (paymentMethod === 'account' && !AccountId) {
      return res
        .status(400)
        .json({
          msg: 'Bank account is required when payment method is account',
        });
    }

    // Make sure user owns scheduled payment
    if (scheduledPayment.UserId !== req.userId) {
      return res.status(401).json({ msg: 'Not authorized' });
    }

    // Re-anchor nextDueDate ONLY when the user actually changes startDate, and
    // never move it backwards into the past: a past nextDueDate makes the cron
    // re-materialize every elapsed period, producing duplicate transactions.
    // Editing any other field leaves nextDueDate untouched (the cron owns it).
    // DATEONLY values are 'YYYY-MM-DD' strings, so lexicographic comparison works.
    let nextDueDate = scheduledPayment.nextDueDate;
    if (startDate && startDate !== scheduledPayment.startDate) {
      const now = new Date();
      const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      nextDueDate = startDate > todayStr ? startDate : todayStr;
    }

    await scheduledPayment.update({
      name,
      type,
      amount,
      period,
      CardId: paymentMethod === 'card' ? CardId : null,
      AccountId: paymentMethod === 'account' ? AccountId : null,
      paymentMethod,
      CategoryId,
      description,
      startDate,
      endDate,
      occurrences,
      specificDay,
      status,
      nextDueDate,
    });

    res.json(scheduledPayment);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   DELETE api/scheduled-payments/:id
// @desc    Delete a scheduled payment
// @access  Private
router.delete('/:id', async (req, res) => {
  try {
    let scheduledPayment = await ScheduledPayment.findByPk(req.params.id);

    if (!scheduledPayment)
      return res.status(404).json({ msg: 'Scheduled payment not found' });

    // Make sure user owns scheduled payment
    if (scheduledPayment.UserId !== req.userId) {
      return res.status(401).json({ msg: 'Not authorized' });
    }

    await scheduledPayment.destroy();

    res.json({ msg: 'Scheduled payment removed' });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

export default router;
