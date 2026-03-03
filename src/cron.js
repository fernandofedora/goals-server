import cron from 'node-cron';
import { ScheduledPayment, Transaction } from './models/index.js';

// Schedule a task to run every day at midnight
cron.schedule('0 0 * * *', async () => {
  console.log('Running scheduled payments check...');
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  try {
    const scheduledPayments = await ScheduledPayment.findAll({
      where: {
        status: 'active',
        nextDueDate: { $lte: today },
      },
    });

    for (const payment of scheduledPayments) {
      // Create a new transaction
      await Transaction.create({
        UserId: payment.UserId,
        type: payment.type,
        amount: payment.amount,
        CategoryId: payment.CategoryId,
        CardId: payment.CardId,
        date: payment.nextDueDate,
        description: `Scheduled: ${payment.name}`,
        paymentMethod: 'card' // Assuming card payment for now
      });

      // Update the next due date
      const newNextDueDate = new Date(payment.nextDueDate);
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
    }
  } catch (err) {
    console.error('Error processing scheduled payments:', err);
  }
});
