import express from 'express';
import { Op } from 'sequelize';
import { authMiddleware } from '../middleware/auth.js';
import { ScheduledPayment, Category, Card, Account, Transaction } from '../models/index.js';

const router = express.Router();
router.use(authMiddleware);



// @route   POST api/scheduled-payments
// @desc    Create a scheduled payment
// @access  Private
router.post('/', async (req, res) => {
  const { name, type, amount, period, CardId, AccountId, paymentMethod, CategoryId, description, startDate, endDate, occurrences, specificDay } = req.body;

  try {
    // Simple validation
    if (!name || !type || !amount || !period || !CategoryId || !startDate || !paymentMethod || !endDate) {
      return res.status(400).json({ msg: 'Please enter all required fields' });
    }
    if (paymentMethod === 'card' && !CardId) {
      return res.status(400).json({ msg: 'Credit card is required when payment method is card' });
    }
    if (paymentMethod === 'account' && !AccountId) {
      return res.status(400).json({ msg: 'Bank account is required when payment method is account' });
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
      include: [Category, Card, Account]
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
  const { name, type, amount, period, CardId, AccountId, paymentMethod, CategoryId, description, startDate, endDate, occurrences, specificDay, status } = req.body;

  try {
    let scheduledPayment = await ScheduledPayment.findByPk(req.params.id);

    if (!scheduledPayment) return res.status(404).json({ msg: 'Scheduled payment not found' });

    if (paymentMethod === 'card' && !CardId) {
      return res.status(400).json({ msg: 'Credit card is required when payment method is card' });
    }
    if (paymentMethod === 'account' && !AccountId) {
      return res.status(400).json({ msg: 'Bank account is required when payment method is account' });
    }

    // Make sure user owns scheduled payment
    if (scheduledPayment.UserId !== req.userId) {
      return res.status(401).json({ msg: 'Not authorized' });
    }

    let nextDueDate = scheduledPayment.nextDueDate; // this is 'YYYY-MM-DD' from DB
    if (startDate) {
      // Since Sequelize DATEONLY returns 'YYYY-MM-DD', we can just use lexicographical comparison
      // or simple Date parsing to check if cron advanced it.
      // If the currently saved nextDueDate is before or equal to the new startDate,
      // it means the cron hasn't moved past the new start date yet, so we sync it.
      // Also if we just changed the startDate, it's safer to sync it.
      if (scheduledPayment.nextDueDate <= startDate || startDate !== scheduledPayment.startDate) {
        nextDueDate = startDate;
      }
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

    if (!scheduledPayment) return res.status(404).json({ msg: 'Scheduled payment not found' });

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
