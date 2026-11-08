import { describe, expect, it } from 'vitest';
import { advanceDueDate } from '../src/cron.js';

describe('advanceDueDate', () => {
  it.each([
    ['2026-01-31', 'daily', '2026-02-01'],
    ['2026-12-28', 'weekly', '2027-01-04'],
    ['2026-02-20', 'bi-weekly', '2026-03-06'],
    ['2026-01-15', 'monthly', '2026-02-15'],
    ['2026-12-15', 'monthly', '2027-01-15'],
    ['2026-01-15', 'quarterly', '2026-04-15'],
    ['2026-11-15', 'quarterly', '2027-02-15'],
    ['2026-06-10', 'yearly', '2027-06-10'],
  ])('%s + %s = %s', (from, period, expected) => {
    expect(advanceDueDate(from, period)).toBe(expected);
  });

  it.each([
    ['2026-01-31', 'monthly', '2026-02-28'],
    ['2028-01-31', 'monthly', '2028-02-29'],
    ['2026-03-31', 'monthly', '2026-04-30'],
    ['2026-11-30', 'quarterly', '2027-02-28'],
    ['2028-02-29', 'yearly', '2029-02-28'],
  ])('snaps %s + %s to the last valid day (%s)', (from, period, expected) => {
    expect(advanceDueDate(from, period)).toBe(expected);
  });
});
