import { Op } from 'sequelize';
import { PortfolioSnapshot, User } from '../models/index.js';
import { portfolioTotals } from './portfolio.js';
import { seesInvestments } from './netWorth.js';

const pad = (n) => String(n).padStart(2, '0');
/** Server-local 'YYYY-MM-DD', like the other daily jobs. */
export const localDay = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const HISTORY_RANGES = { '1m': 1, '3m': 3, '6m': 6, '1y': 12, all: null };

/** Saves (or overwrites) one day of a user's portfolio totals. */
export async function savePortfolioSnapshot(userId, { value, cost }, currency, date = localDay()) {
  await PortfolioSnapshot.upsert({ UserId: userId, date, value, cost, currency });
}

/**
 * Daily cron step: today's totals of every investor with priced holdings.
 * The investments page also saves them on each visit, so a day the host
 * was asleep at cron time still gets a point if the user opened it.
 */
export async function recordPortfolioSnapshots(now = new Date()) {
  const users = await User.findAll({ where: { isActive: true } });
  const date = localDay(now);
  let saved = 0;
  for (const user of users.filter(seesInvestments)) {
    try {
      const currency = user.currency || 'USD';
      const totals = await portfolioTotals(user.id, currency);
      if (!totals.counted) continue;
      await savePortfolioSnapshot(user.id, totals, currency, date);
      saved += 1;
    } catch (err) {
      console.error(`Portfolio snapshot failed for user ${user.id}:`, err.message);
    }
  }
  return saved;
}

/**
 * Snapshots of the last `range` (see HISTORY_RANGES), oldest first. Only
 * those in `currency`: a day saved before the user changed currency would
 * not compare.
 */
export async function portfolioHistory(userId, currency, range = '3m', now = new Date()) {
  const months = HISTORY_RANGES[range];
  const where = { UserId: userId, currency };
  if (months) {
    const from = new Date(now.getFullYear(), now.getMonth() - months, now.getDate());
    where.date = { [Op.gte]: localDay(from) };
  }
  const rows = await PortfolioSnapshot.findAll({ where, order: [['date', 'ASC']], raw: true });
  return rows.map((r) => ({
    date: String(r.date).slice(0, 10),
    value: Number(r.value),
    cost: Number(r.cost),
  }));
}
