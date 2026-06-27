import cron from 'node-cron';
import { Op } from 'sequelize';
import { sequelize } from './config/db.js';
import { ScheduledPayment, Transaction } from './models/index.js';

// Safety cap: never materialize more than this many occurrences for a single
// payment in one catch-up pass, to guard against an unbounded loop on bad data.
const CATCH_UP_SAFETY_CAP = 1000;

/** Format a Date to a local 'YYYY-MM-DD' string (matches DATEONLY storage). */
function formatLocalDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Advance a 'YYYY-MM-DD' date string by one period. Pure and timezone-safe:
 * parses with a 'T00:00:00' suffix to force local-time parsing, then formats
 * back to 'YYYY-MM-DD'. Month/quarter/year roll-overs snap to the last valid
 * day of the target month (e.g. Jan 31 +1mo -> Feb 28/29; Feb 29 +1yr -> Feb 28).
 */
export function advanceDueDate(dateStr, period) {
  const d = new Date(dateStr + 'T00:00:00');
  const currentDay = d.getDate();
  switch (period) {
    case 'daily':
      d.setDate(d.getDate() + 1);
      break;
    case 'weekly':
      d.setDate(d.getDate() + 7);
      break;
    case 'bi-weekly':
      d.setDate(d.getDate() + 14);
      break;
    case 'monthly':
      d.setMonth(d.getMonth() + 1);
      if (d.getDate() !== currentDay) d.setDate(0); // snap to last valid day
      break;
    case 'quarterly':
      d.setMonth(d.getMonth() + 3);
      if (d.getDate() !== currentDay) d.setDate(0);
      break;
    case 'yearly':
      d.setFullYear(d.getFullYear() + 1);
      if (currentDay === 29 && d.getDate() !== 29) d.setDate(0); // Feb 29 -> 28
      break;
  }
  return formatLocalDate(d);
}

export const processScheduledPayments = async () => {
  console.log('Running scheduled payments check...');
  const todayStr = formatLocalDate(new Date());

  try {
    const scheduledPayments = await ScheduledPayment.findAll({
      where: {
        status: 'active',
        nextDueDate: { [Op.lte]: todayStr },
      },
    });

    console.log(
      `Found ${scheduledPayments.length} scheduled payment(s) to process.`,
    );

    // The findAll above is only candidate selection (no lock). The authoritative
    // read happens per-payment *inside* the transaction under a row lock below,
    // so a stale nextDueDate captured here can never cause a double insert.
    for (const candidate of scheduledPayments) {
      try {
        // Catch-up: a payment may be overdue by many periods (server asleep on
        // shared hosting, or the previously missing catch-up loop). Materialize
        // one transaction per missed period until nextDueDate is in the future
        // or the payment ends. Wrapped in a single DB transaction so a mid-loop
        // failure rolls back entirely -- no partial writes, and idempotent on
        // the next run because nextDueDate only advances on commit.
        await sequelize.transaction(async (t) => {
          // Re-read the row under a row lock (SELECT ... FOR UPDATE). This is the
          // core duplicate guard: two concurrent runs -- multiple instances, or
          // the startup catch-up overlapping the midnight tick -- serialize here.
          // The second run blocks until the first commits, then sees the already
          // advanced nextDueDate and exits the loop without re-materializing.
          const payment = await ScheduledPayment.findByPk(candidate.id, {
            lock: t.LOCK.UPDATE,
            transaction: t,
          });

          // Already handled by a concurrent run, paused, or no longer due.
          if (
            !payment ||
            payment.status !== 'active' ||
            payment.nextDueDate > todayStr
          ) {
            return;
          }

          let dueStr = payment.nextDueDate;
          let occurrences = payment.occurrences;
          let status = payment.status;
          const endDateStr = payment.endDate;
          let materialized = 0;

          while (
            dueStr <= todayStr &&
            status === 'active' &&
            materialized < CATCH_UP_SAFETY_CAP
          ) {
            // Never materialize an occurrence past the payment's end date.
            if (endDateStr && dueStr > endDateStr) {
              status = 'paused';
              break;
            }

            try {
              await Transaction.create(
                {
                  UserId: payment.UserId,
                  type: payment.type,
                  amount: payment.amount,
                  CategoryId: payment.CategoryId,
                  CardId:
                    payment.paymentMethod === 'card' ? payment.CardId : null,
                  AccountId:
                    payment.paymentMethod === 'account'
                      ? payment.AccountId
                      : null,
                  date: dueStr,
                  description: `Scheduled: ${payment.name}`,
                  paymentMethod: payment.paymentMethod || 'cash',
                  ScheduledPaymentId: payment.id,
                },
                { transaction: t },
              );
              materialized += 1;
            } catch (createErr) {
              // Backstop against the unique (ScheduledPaymentId, date) index: a
              // transaction for this exact occurrence already exists. Skip the
              // insert but keep advancing so we don't loop on the same date.
              if (createErr.name === 'SequelizeUniqueConstraintError') {
                console.warn(
                  `Skipped duplicate occurrence for "${payment.name}" on ${dueStr}`,
                );
              } else {
                throw createErr;
              }
            }

            dueStr = advanceDueDate(dueStr, payment.period);

            // Each materialized payment consumes one occurrence (when limited).
            if (occurrences != null) {
              occurrences -= 1;
              if (occurrences === 0) status = 'paused';
            }

            // Once the next occurrence falls past the end date, stop.
            if (endDateStr && dueStr > endDateStr) status = 'paused';
          }

          payment.nextDueDate = dueStr;
          payment.occurrences = occurrences;
          payment.status = status;
          await payment.save({ transaction: t });

          console.log(
            `Processed payment: "${payment.name}" (${payment.period}) -> ` +
              `materialized ${materialized} transaction(s), next due: ${payment.nextDueDate}, status: ${payment.status}`,
          );
        });
      } catch (innerErr) {
        console.error(
          `Error processing individual payment ${candidate.id}:`,
          innerErr,
        );
        // Auto-pause failing payments to avoid an infinite loop of silent
        // failures. Reload first to discard any in-memory mutations from the
        // rolled-back transaction above, so we only persist the paused status.
        try {
          await candidate.reload();
          candidate.status = 'paused';
          await candidate.save();
          console.log(`Auto-paused payment ${candidate.id} due to error.`);
        } catch (saveErr) {
          console.error(
            `Could not auto-pause payment ${candidate.id}:`,
            saveErr,
          );
        }
      }
    }
  } catch (err) {
    console.error('Error processing scheduled payments:', err);
  }
};

// Schedule the daily run at midnight for long-running instances. Registering
// the timer at import is safe -- the callback only hits the DB at midnight, by
// which point the connection is up. The startup catch-up run is orchestrated by
// index.js *after* connectDB() resolves (it used to run here on module import,
// before the DB was ready -- a race on cold/managed databases).
cron.schedule('0 0 * * *', processScheduledPayments);
