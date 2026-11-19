import { clampedDate } from './cardCycle.js';

// Periods of a flexible budget. A start day a month lacks (29–31) falls on the
// month's last day, like card statements and scheduled payments.

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (s, n) => {
  const d = parse(s);
  d.setDate(d.getDate() + n);
  return iso(d);
};
const monthShift = (y, m, delta) => {
  const d = new Date(y, m - 1 + delta, 1);
  return [d.getFullYear(), d.getMonth() + 1];
};

/** Start of the period that contains `date`. */
function startOf(type, startDay, date) {
  const [y, m] = date.split('-').map(Number);
  if (type === 'weekly') {
    // startDay 1–7 is Monday–Sunday.
    const weekday = ((parse(date).getDay() + 6) % 7) + 1;
    return addDays(date, -((weekday - startDay + 7) % 7));
  }
  const step = type === 'quarterly' ? 3 : 1;
  // Quarters run from January, April, July and October.
  let [py, pm] = type === 'quarterly' ? [y, m - ((m - 1) % 3)] : [y, m];
  let start = clampedDate(py, pm, startDay);
  if (start > date) {
    [py, pm] = monthShift(py, pm, -step);
    start = clampedDate(py, pm, startDay);
  }
  return start;
}

/** The period `{ start, end }` of a budget that contains `date` (YYYY-MM-DD). */
export function periodFor(type, startDay, date) {
  const start = startOf(type, startDay, date);
  return { start, end: addDays(nextStart(type, startDay, start), -1) };
}

function nextStart(type, startDay, start) {
  if (type === 'weekly') return addDays(start, 7);
  const [y, m] = start.split('-').map(Number);
  // The month the period nominally began in: a clamped start (Feb 28 for a
  // 31st) still belongs to its own month.
  const [ny, nm] = monthShift(y, m, type === 'quarterly' ? 3 : 1);
  return clampedDate(ny, nm, startDay);
}

/** The period right before `period`. */
export const previousPeriod = (type, startDay, period) =>
  periodFor(type, startDay, addDays(period.start, -1));

/** The period right after `period`. */
export const nextPeriod = (type, startDay, period) =>
  periodFor(type, startDay, addDays(period.end, 1));

/** Days from `start` to `end`, both included. */
export const daysBetween = (start, end) =>
  Math.round((parse(end) - parse(start)) / 86400000) + 1;

export { addDays };
