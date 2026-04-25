import cron from 'node-cron';
import { Op } from 'sequelize';
import { ScheduledPayment, Transaction } from './models/index.js';

export const processScheduledPayments = async () => {
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
      try {
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
          paymentMethod: payment.paymentMethod || 'cash',
        });

        // Update the next due date
        // Use 'T00:00:00' suffix to force local timezone parsing (not UTC),
        // so setDate() arithmetic is always accurate regardless of server timezone.
        const newNextDueDate = new Date(payment.nextDueDate + 'T00:00:00');
        const currentDay = newNextDueDate.getDate();

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
            if (newNextDueDate.getDate() !== currentDay) {
              newNextDueDate.setDate(0); // Snap to last valid day of target month
            }
            break;
          case 'quarterly':
            newNextDueDate.setMonth(newNextDueDate.getMonth() + 3);
            if (newNextDueDate.getDate() !== currentDay) {
              newNextDueDate.setDate(0); // Snap to last valid day of target month
            }
            break;
          case 'yearly':
            newNextDueDate.setFullYear(newNextDueDate.getFullYear() + 1);
            if (currentDay === 29 && newNextDueDate.getDate() !== 29) {
              newNextDueDate.setDate(0); // Snap to Feb 28 for leap years
            }
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

        // Handle end date (safely compare Dates instead of string vs Date)
        if (payment.endDate) {
          const endDateObj = new Date(payment.endDate + 'T00:00:00');
          if (newNextDueDate > endDateObj) {
            payment.status = 'paused';
          }
        }

        await payment.save();
        console.log(`Processed payment: "${payment.name}" (${payment.period}) → next due: ${payment.nextDueDate}`);
      } catch (innerErr) {
        console.error(`Error processing individual payment ${payment.id}:`, innerErr);
        // Auto-pause failing payments to avoid infinite loop of silent failures
        try {
          payment.status = 'paused';
          await payment.save();
          console.log(`Auto-paused payment ${payment.id} due to error.`);
        } catch (saveErr) {
          console.error(`Could not auto-pause payment ${payment.id}:`, saveErr);
        }
      }
    }
  } catch (err) {
    console.error('Error processing scheduled payments:', err);
  }
};

// Schedule a task to run every day at midnight (for active long-running instances)
cron.schedule('0 0 * * *', processScheduledPayments);

// Run immediately on startup to catch up on missed ticks (handles shared hosting sleep/wake cycles)
processScheduledPayments();
