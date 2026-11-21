import { UniqueConstraintError } from 'sequelize';
import { SpendingBudgetAlert, User } from '../models/index.js';
import { sendBudgetAlertEmail } from '../utils/mail.js';
import {
  budgetStatuses,
  budgetsCovering,
  localToday,
} from './spendingBudgets.js';
import { formatMoney } from '../utils/money.js';

const THRESHOLDS = [80, 100];

/**
 * After an expense in `categoryId` (with `tagIds`) on `date`, email the user
 * once per threshold (80%, 100%), budget and period. Only the running period
 * alerts: an old expense entered late is history, not a warning. Never throws.
 */
export async function checkBudgetThresholds(
  userId,
  categoryId,
  date,
  today = localToday(),
  tagIds = [],
) {
  try {
    if (!date || (!categoryId && !tagIds.length)) return [];
    const user = await User.findByPk(userId);
    if (!user || !user.budgetAlertsEnabled || !user.isActive) return [];

    const covering = await budgetsCovering(userId, {
      CategoryId: categoryId,
      tagIds,
    });
    if (!covering.length) return [];
    const ids = new Set(covering.map((b) => b.id));
    const statuses = (await budgetStatuses(userId, today)).filter(
      (s) => ids.has(s.id) && date >= s.period.start && date <= s.period.end,
    );

    const sent = [];
    for (const status of statuses) {
      const crossed = THRESHOLDS.filter((th) => status.percent >= th);
      if (!crossed.length) continue;

      // Claim each crossed threshold; the unique index makes a repeat a no-op.
      const claimed = [];
      for (const threshold of crossed) {
        try {
          claimed.push(
            await SpendingBudgetAlert.create({
              UserId: userId,
              SpendingBudgetId: status.id,
              periodStart: status.period.start,
              threshold,
            }),
          );
        } catch (err) {
          if (!(err instanceof UniqueConstraintError)) throw err;
        }
      }
      if (!claimed.length) continue;

      // Jumping straight past 100% sends one email, not two.
      const threshold = Math.max(...claimed.map((c) => c.threshold));
      try {
        await sendBudgetAlertEmail({
          email: user.email,
          name: user.name,
          language: user.language,
          categoryName: status.name,
          threshold,
          spent: formatMoney(status.spent, user.currency || 'USD'),
          budget: formatMoney(status.available, user.currency || 'USD'),
          percent: Math.round(status.percent),
        });
        sent.push({ budgetId: status.id, threshold });
      } catch (mailErr) {
        // Release the claim so the next expense retries the email.
        console.error(
          `Budget alert email failed for user ${userId}:`,
          mailErr.message,
        );
        await Promise.all(claimed.map((c) => c.destroy()));
      }
    }
    return sent;
  } catch (err) {
    console.error('Budget alert check failed:', err);
    return [];
  }
}
