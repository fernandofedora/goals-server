// Statement cycles of a credit card. A day of the month that a month lacks
// (29–31) falls on that month's last day, like scheduled payments in cron.js.

const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const daysIn = (y, m) => new Date(y, m, 0).getDate();

/** `day` of month `m` (1–12) of year `y`, clamped to the month's last day. */
export const clampedDate = (y, m, day) =>
  iso(y, m, Math.min(day, daysIn(y, m)));

const shift = (y, m, delta) => {
  const d = new Date(y, m - 1 + delta, 1);
  return [d.getFullYear(), d.getMonth() + 1];
};

const nextDay = (dateStr) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  const next = new Date(y, m - 1, d + 1);
  return iso(next.getFullYear(), next.getMonth() + 1, next.getDate());
};

/**
 * The cycle `today` belongs to and the one that closed before it.
 * - `current`: from the day after the last statement through the next one.
 * - `previous`: the closed cycle whose statement is due next.
 * - `dueDate`: the first `dueDay` after the last statement (same month when
 *   the due day comes later in the month, next month otherwise).
 */
export function cardCycle(statementDay, dueDay, today) {
  const [y, m] = today.split('-').map(Number);
  const thisMonth = clampedDate(y, m, statementDay);
  // The statement closes at the end of its day, so a cut today belongs to this month.
  const lastStatement =
    thisMonth <= today ? thisMonth : clampedDate(...shift(y, m, -1), statementDay);
  const [ly, lm] = lastStatement.split('-').map(Number);
  const nextStatement = clampedDate(...shift(ly, lm, 1), statementDay);
  const beforeLast = clampedDate(...shift(ly, lm, -1), statementDay);

  let dueDate = null;
  if (dueDay) {
    const sameMonth = clampedDate(ly, lm, dueDay);
    dueDate =
      sameMonth > lastStatement
        ? sameMonth
        : clampedDate(...shift(ly, lm, 1), dueDay);
  }

  return {
    current: { start: nextDay(lastStatement), end: nextStatement },
    previous: { start: nextDay(beforeLast), end: lastStatement },
    statementDate: lastStatement,
    dueDate,
  };
}
