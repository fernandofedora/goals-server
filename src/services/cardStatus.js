import { col, fn } from 'sequelize';
import { Card, Category, Transaction } from '../models/index.js';
import { cardCycle } from '../utils/cardCycle.js';

const pad = (n) => String(n).padStart(2, '0');
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const round2 = (n) => Math.round(n * 100) / 100;
const within = (date, { start, end }) => date >= start && date <= end;

/**
 * Where each card stands today:
 * - `balance`: what is owed, all spending minus everything that came in
 *   (payments, which are transfer legs since F1.4, and refunds).
 * - `cycle`: spending of the running statement cycle.
 * - `statement`: the closed cycle, its due date and what is left to pay of it.
 * Refunds lower a cycle's spending; payments only lower what is owed.
 */
export async function cardStatuses(userId, today = localToday()) {
  const cards = await Card.findAll({ where: { UserId: userId } });
  if (!cards.length) return [];
  const transferIds = new Set(
    (
      await Category.findAll({
        where: { UserId: userId, type: 'transfer' },
        attributes: ['id'],
      })
    ).map((c) => c.id),
  );
  const rows = await Transaction.findAll({
    where: { UserId: userId, CardId: cards.map((c) => c.id) },
    attributes: ['CardId', 'type', 'amount', 'date', 'CategoryId'],
    raw: true,
  });

  return cards.map((card) => {
    const mine = rows.filter((r) => r.CardId === card.id);
    const isPayment = (r) =>
      r.type === 'income' && transferIds.has(r.CategoryId);
    const signed = (r) => (r.type === 'expense' ? 1 : -1) * Number(r.amount);
    const spendIn = (range) =>
      round2(
        mine
          .filter((r) => !isPayment(r) && within(r.date, range))
          .reduce((s, r) => s + signed(r), 0),
      );

    const balance = round2(mine.reduce((s, r) => s + signed(r), 0));
    const limit = card.creditLimit != null ? Number(card.creditLimit) : null;
    const status = {
      cardId: card.id,
      creditLimit: limit,
      balance,
      available: limit != null ? round2(limit - Math.max(0, balance)) : null,
      usedPercent: limit
        ? Math.round((Math.max(0, balance) / limit) * 1000) / 10
        : null,
      cycle: null,
      statement: null,
    };

    if (card.statementDay) {
      const c = cardCycle(card.statementDay, card.dueDay, today);
      const closed = Math.max(0, spendIn(c.previous));
      const paid = mine
        .filter(
          (r) => isPayment(r) && r.date > c.statementDate && r.date <= today,
        )
        .reduce((s, r) => s + Number(r.amount), 0);
      status.cycle = { ...c.current, spent: spendIn(c.current) };
      status.statement = {
        date: c.statementDate,
        amount: round2(closed),
        dueDate: c.dueDate,
        paid: round2(paid),
        remaining: round2(Math.max(0, closed - paid)),
      };
    }
    return status;
  });
}

/**
 * Debt of the cards the user tracks as credit (those with a limit), today and
 * at each month close. A card without a limit may never have its payments
 * recorded, so its balance would only grow and is left out.
 */
export async function cardDebts(userId) {
  const cards = await Card.findAll({
    where: { UserId: userId },
    attributes: ['id', 'creditLimit'],
  });
  const tracked = cards.filter((c) => c.creditLimit != null).map((c) => c.id);
  if (!tracked.length) return { today: 0, netByMonth: new Map() };
  const month = fn('DATE_FORMAT', col('date'), '%Y-%m');
  const rows = await Transaction.findAll({
    attributes: ['type', [month, 'month'], [fn('SUM', col('amount')), 'total']],
    where: { UserId: userId, CardId: tracked },
    group: ['type', month],
    raw: true,
  });
  const netByMonth = new Map();
  for (const r of rows) {
    const signed = (r.type === 'expense' ? 1 : -1) * Number(r.total);
    netByMonth.set(r.month, (netByMonth.get(r.month) || 0) + signed);
  }
  const total = [...netByMonth.values()].reduce((s, v) => s + v, 0);
  return { today: round2(Math.max(0, total)), netByMonth };
}

/** Debt at the close of a month (never negative: money in favor is not debt). */
export function debtAtClose({ netByMonth }, key) {
  let total = 0;
  for (const [month, net] of netByMonth) if (month <= key) total += net;
  return round2(Math.max(0, total));
}
