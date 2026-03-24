import express from 'express';
import { Op } from 'sequelize';
import { authMiddleware } from '../middleware/auth.js';
import { ScheduledPayment, Category, Card, Account, Transaction } from '../models/index.js';

const router = express.Router();
router.use(authMiddleware);

// @route   POST api/scheduled-payments/run-now
// @desc    [TEMP TEST ENDPOINT] Trigger scheduled payment processing immediately for the current user
// @access  Private
// TODO: Remove this endpoint after verification
router.post('/run-now', async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const scheduledPayments = await ScheduledPayment.findAll({
      where: {
        UserId: req.userId,
        status: 'active',
        nextDueDate: { [Op.lte]: today },
      },
    });

    const processed = [];

    for (const payment of scheduledPayments) {
      await Transaction.create({
        UserId: payment.UserId,
        type: payment.type,
        amount: payment.amount,
        CategoryId: payment.CategoryId,
        CardId: payment.paymentMethod === 'card' ? payment.CardId : null,
        AccountId: payment.paymentMethod === 'account' ? payment.AccountId : null,
        date: payment.nextDueDate,
        description: `Scheduled: ${payment.name}`,
        paymentMethod: payment.paymentMethod,
      });

      const newNextDueDate = new Date(payment.nextDueDate + 'T00:00:00');
      switch (payment.period) {
        case 'daily':      newNextDueDate.setDate(newNextDueDate.getDate() + 1); break;
        case 'weekly':     newNextDueDate.setDate(newNextDueDate.getDate() + 7); break;
        case 'bi-weekly':  newNextDueDate.setDate(newNextDueDate.getDate() + 14); break;
        case 'monthly':    newNextDueDate.setMonth(newNextDueDate.getMonth() + 1); break;
        case 'quarterly':  newNextDueDate.setMonth(newNextDueDate.getMonth() + 3); break;
        case 'yearly':     newNextDueDate.setFullYear(newNextDueDate.getFullYear() + 1); break;
      }
      payment.nextDueDate = newNextDueDate;

      if (payment.occurrences) {
        payment.occurrences -= 1;
        if (payment.occurrences === 0) payment.status = 'paused';
      }
      if (payment.endDate && newNextDueDate > payment.endDate) {
        payment.status = 'paused';
      }

      await payment.save();
      processed.push({ name: payment.name, period: payment.period, newNextDueDate: payment.nextDueDate });
    }

    res.json({ processed: processed.length, details: processed });
  } catch (err) {
    console.error('Error running scheduled payments manually:', err);
    res.status(500).send('Server Error');
  }
});

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
