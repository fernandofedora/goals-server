import cron from 'node-cron';
import { Op } from 'sequelize';
import { ScheduledPayment, Transaction } from './models/index.js';

// Schedule a task to run every day at midnight
cron.schedule('0 0 * * *', async () => {
  console.log('Running scheduled payments check...');
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  try {
    // Bug fix #1: use Sequelize Op.lte instead of MongoDB-style $lte
    const scheduledPayments = await ScheduledPayment.findAll({
      where: {
        status: 'active',
        nextDueDate: { [Op.lte]: today },
      },
    });

    console.log(`Found ${scheduledPayments.length} scheduled payment(s) to process.`);

    for (const payment of scheduledPayments) {
      // Bug fix #2: use the stored paymentMethod instead of hardcoding 'card'
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

      // Update the next due date
      // Use 'T00:00:00' suffix to force local timezone parsing (not UTC),
      // so setDate() arithmetic is always accurate regardless of server timezone.
      const newNextDueDate = new Date(payment.nextDueDate + 'T00:00:00');
      switch (payment.period) {
        case 'daily':
          newNextDueDate.setDate(newNextDueDate.getDate() + 1);
          break;
        case 'weekly':
          newNextDueDate.setDate(newNextDueDate.getDate() + 7);
          break;
        case 'bi-weekly':
          newNextDueDate.setDate(newNextDueDate.getDate() + 14);
          break;
        case 'monthly':
          newNextDueDate.setMonth(newNextDueDate.getMonth() + 1);
          break;
        case 'quarterly':
          newNextDueDate.setMonth(newNextDueDate.getMonth() + 3);
          break;
        case 'yearly':
          newNextDueDate.setFullYear(newNextDueDate.getFullYear() + 1);
          break;
      }
      payment.nextDueDate = newNextDueDate;

      // Handle occurrences
      if (payment.occurrences) {
        payment.occurrences -= 1;
        if (payment.occurrences === 0) {
          payment.status = 'paused';
        }
      }

      // Handle end date
      if (payment.endDate && newNextDueDate > payment.endDate) {
        payment.status = 'paused';
      }

      await payment.save();
      console.log(`Processed payment: "${payment.name}" (${payment.period}) → next due: ${payment.nextDueDate}`);
    }
  } catch (err) {
    console.error('Error processing scheduled payments:', err);
  }
});
