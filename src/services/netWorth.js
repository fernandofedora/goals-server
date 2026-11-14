import { col, fn } from 'sequelize';
import {
  Account,
  NetWorthSnapshot,
  Transaction,
  User,
} from '../models/index.js';
import { portfolioValue } from './portfolio.js';

const pad = (n) => String(n).padStart(2, '0');
const round2 = (n) => Math.round(n * 100) / 100;
const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const monthEnd = (key) => {
  const [y, m] = key.split('-').map(Number);
  return `${key}-${pad(new Date(y, m, 0).getDate())}`;
};

/** Super admins and invited users see investments; for the rest they don't count. */
export const seesInvestments = (user) =>
  Boolean(user?.isSuperAdmin || user?.canAccessInvestments);

/**
 * Balance of the integrated accounts at the close of each month, plus today's
 * (which, like the Accounts page, includes future-dated movements).
 */
async function accountBalances(userId) {
  const accounts = await Account.findAll({
    where: { UserId: userId, isExcludedFromTotals: false },
    attributes: ['id', 'initialBalance'],
  });
  const initial = accounts.reduce(
    (s, a) => s + Number(a.initialBalance || 0),
    0,
  );
  if (!accounts.length) return { initial: 0, netByMonth: new Map(), today: 0 };

  const month = fn('DATE_FORMAT', col('date'), '%Y-%m');
  const rows = await Transaction.findAll({
    attributes: ['type', [month, 'month'], [fn('SUM', col('amount')), 'total']],
    where: { UserId: userId, AccountId: accounts.map((a) => a.id) },
    group: ['type', month],
    raw: true,
  });
  const netByMonth = new Map();
  for (const r of rows) {
    const signed = (r.type === 'income' ? 1 : -1) * Number(r.total);
    netByMonth.set(r.month, (netByMonth.get(r.month) || 0) + signed);
  }
  const allNet = [...netByMonth.values()].reduce((s, v) => s + v, 0);
  return { initial, netByMonth, today: round2(initial + allNet) };
}

const balanceAtClose = ({ initial, netByMonth }, key) => {
  let total = initial;
  for (const [month, net] of netByMonth) if (month <= key) total += net;
  return round2(total);
};

/** Live net worth right now. */
export async function currentNetWorth(user) {
  const balances = await accountBalances(user.id);
  const investments = seesInvestments(user)
    ? await portfolioValue(user.id, user.currency || 'USD')
    : 0;
  return {
    accounts: balances.today,
    investments,
    debts: 0,
    total: round2(balances.today + investments),
    balances,
  };
}

/**
 * The last `months` month closes, oldest first, ending with the running month
 * (live values). Accounts are always recomputed from transactions, so a late
 * entry still shows up; investments use the month's snapshot when the cron
 * saved one (market value) and their cost otherwise.
 */
export async function netWorthHistory(user, months = 13, now = new Date()) {
  const current = await currentNetWorth(user);
  const keys = Array.from({ length: months }, (_, i) =>
    monthKey(new Date(now.getFullYear(), now.getMonth() - (months - 1 - i), 1)),
  );
  const withInvestments = seesInvestments(user);
  const snapshots = withInvestments
    ? await NetWorthSnapshot.findAll({
        where: { UserId: user.id, date: keys.map(monthEnd) },
        raw: true,
      })
    : [];
  const snapshotBy = new Map(
    snapshots.map((s) => [String(s.date).slice(0, 7), s]),
  );

  const history = [];
  for (const key of keys) {
    if (key === keys[keys.length - 1]) {
      history.push({
        month: key,
        accounts: current.accounts,
        investments: current.investments,
        total: current.total,
      });
      continue;
    }
    const accounts = balanceAtClose(current.balances, key);
    let investments = 0;
    if (withInvestments) {
      const snap = snapshotBy.get(key);
      investments = snap
        ? Number(snap.investments)
        : await portfolioValue(user.id, user.currency || 'USD', monthEnd(key));
    }
    history.push({
      month: key,
      accounts,
      investments,
      total: round2(accounts + investments),
    });
  }
  delete current.balances;
  return { current, history, includesInvestments: withInvestments };
}

/**
 * Daily cron step: keeps this month's snapshot of every investor current, so
 * when the month ends its last saved value is the close at market price.
 */
export async function recordNetWorthSnapshots(now = new Date()) {
  const users = await User.findAll({ where: { isActive: true } });
  const date = monthEnd(monthKey(now));
  let saved = 0;
  for (const user of users.filter(seesInvestments)) {
    try {
      const { accounts, investments, debts, total } =
        await currentNetWorth(user);
      if (!investments) continue;
      await NetWorthSnapshot.upsert({
        UserId: user.id,
        date,
        accounts,
        investments,
        debts,
        total,
      });
      saved += 1;
    } catch (err) {
      console.error(
        `Net worth snapshot failed for user ${user.id}:`,
        err.message,
      );
    }
  }
  return saved;
}
