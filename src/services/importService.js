import { randomUUID } from 'crypto';
import { Op, col, fn } from 'sequelize';
import { sequelize } from '../config/db.js';
import { Account, Card, Category, Transaction } from '../models/index.js';
import {
  categoryFits,
  loadRules,
  normalizeText,
  pickRule,
} from '../utils/categoryRules.js';
import { LIMITS } from '../utils/importTemplate.js';
import { checkBudgetThresholds } from './budgetAlerts.js';

const pad = (n) => String(n).padStart(2, '0');
const isoOfUtc = (d) =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
// Excel's day 0 is 1899-12-30; serials are days since then.
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const cleanText = (v) =>
  String(v ?? '')
    .replace(CONTROL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const TYPES = {
  gasto: 'expense',
  expense: 'expense',
  ingreso: 'income',
  income: 'income',
};

/** A real calendar date, or null ("2026-02-30" is not). */
function checkedIso(y, m, d) {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
    ? isoOfUtc(date)
    : null;
}

function parseDate(value, language) {
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? null : isoOfUtc(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 1) return null;
    return isoOfUtc(new Date(EXCEL_EPOCH_MS + Math.floor(value) * 86400000));
  }
  const text = cleanText(value);
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (m) return checkedIso(+m[1], +m[2], +m[3]);
  // Excel saves CSV dates in the local order: day first in Spanish, month first in English.
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (m)
    return language === 'es'
      ? checkedIso(+m[3], +m[2], +m[1])
      : checkedIso(+m[3], +m[1], +m[2]);
  return null;
}

function parseAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = cleanText(value);
  // Plain numbers only: no currency symbol, sign or thousands separator.
  if (!/^\d+([.,]\d+)?$/.test(text)) return null;
  return Number(text.replace(',', '.'));
}

const hasMoreThanTwoDecimals = (n) =>
  Math.abs(n * 100 - Math.round(n * 100)) > 1e-6;

/**
 * Checks one row. Returns the normalized transaction plus `errors`, a list of
 * codes the client translates (the row is left out when any is present).
 */
export function validateRow(raw, { language, categories, maxDate }) {
  const [rawDate, rawDescription, rawAmount, rawType, rawCategory] = raw.cells;
  const errors = [];
  if (raw.formula) errors.push('FORMULA_NOT_ALLOWED');

  const date = parseDate(rawDate, language);
  if (!date) errors.push('DATE_INVALID');
  else if (date < LIMITS.minDate || date > maxDate)
    errors.push('DATE_OUT_OF_RANGE');

  const description = cleanText(rawDescription);
  if (!description) errors.push('DESCRIPTION_REQUIRED');
  else if (description.length > LIMITS.maxDescription)
    errors.push('DESCRIPTION_TOO_LONG');

  const amount = parseAmount(rawAmount);
  if (amount === null || amount <= 0) errors.push('AMOUNT_INVALID');
  else if (amount > LIMITS.maxAmount) errors.push('AMOUNT_OUT_OF_RANGE');
  else if (hasMoreThanTwoDecimals(amount)) errors.push('AMOUNT_DECIMALS');

  const type = TYPES[normalizeText(rawType)] || null;
  if (!type) errors.push('TYPE_INVALID');

  let category = null;
  const categoryName = cleanText(rawCategory);
  if (categoryName) {
    const named = categories.filter(
      (c) => normalizeText(c.name) === normalizeText(categoryName),
    );
    category = named.find((c) => categoryFits(c, type)) || null;
    if (!named.length) errors.push('CATEGORY_NOT_FOUND');
    else if (!category && type) errors.push('CATEGORY_TYPE_MISMATCH');
  }

  return {
    row: raw.row,
    date,
    description: description.slice(0, LIMITS.maxDescription),
    amount:
      amount !== null && Number.isFinite(amount)
        ? Math.round(amount * 100) / 100
        : null,
    type,
    category,
    errors,
  };
}

/** Where imported rows go: `cash`, `account:<id>` or `card:<id>` of the user. */
export async function resolveTarget(userId, target) {
  if (target === 'cash')
    return { paymentMethod: 'cash', AccountId: null, CardId: null };
  const m = /^(account|card):(\d+)$/.exec(String(target || ''));
  if (!m) return null;
  if (m[1] === 'account') {
    const account = await Account.findOne({
      where: { id: m[2], UserId: userId },
    });
    return account
      ? { paymentMethod: 'account', AccountId: account.id, CardId: null }
      : null;
  }
  const card = await Card.findOne({ where: { id: m[2], UserId: userId } });
  return card
    ? { paymentMethod: 'card', AccountId: null, CardId: card.id }
    : null;
}

const dupKey = (t) =>
  `${t.date}|${Math.round(Number(t.amount) * 100)}|${normalizeText(t.description)}|${t.type}`;

/**
 * Validates the rows, marks the ones already registered in the same account or
 * card, and fills empty categories from the user's rules. Repeated rows inside
 * the file only count as duplicates beyond what is already saved, since two
 * equal coffees on the same day can both be real.
 */
export async function buildPreview(userId, language, target, rawRows) {
  const categories = await Category.findAll({ where: { UserId: userId } });
  const now = new Date();
  const maxDate = isoOfUtc(
    new Date(Date.UTC(now.getFullYear() + 1, now.getMonth(), now.getDate())),
  );
  const rows = rawRows.map((raw) =>
    validateRow(raw, { language, categories, maxDate }),
  );
  const valid = rows.filter((r) => !r.errors.length);

  const saved = new Map();
  if (valid.length) {
    const dates = valid.map((r) => r.date).sort();
    const existing = await Transaction.findAll({
      where: {
        UserId: userId,
        AccountId: target.AccountId,
        CardId: target.CardId,
        paymentMethod: target.paymentMethod,
        date: { [Op.between]: [dates[0], dates[dates.length - 1]] },
      },
      attributes: ['date', 'amount', 'description', 'type'],
      raw: true,
    });
    for (const t of existing)
      saved.set(dupKey(t), (saved.get(dupKey(t)) || 0) + 1);
  }

  const rules = await loadRules(userId);
  for (const r of rows) {
    if (r.errors.length) {
      r.status = 'error';
      continue;
    }
    const key = dupKey(r);
    if (saved.get(key)) {
      saved.set(key, saved.get(key) - 1);
      r.status = 'duplicate';
    } else r.status = 'ok';
    if (!r.category) {
      const rule = pickRule(rules, r);
      if (rule) {
        r.category = categories.find((c) => c.id === rule.CategoryId) || null;
        r.ruleName = rule.name;
      }
    }
  }

  const summary = { ok: 0, duplicate: 0, error: 0 };
  for (const r of rows) summary[r.status] += 1;
  return {
    summary,
    rows: rows.map((r) => ({
      row: r.row,
      status: r.status,
      errors: r.errors,
      date: r.date,
      description: r.description,
      amount: r.amount,
      type: r.type,
      categoryId: r.category?.id ?? null,
      categoryName: r.category?.name ?? null,
      ruleName: r.ruleName ?? null,
    })),
  };
}

/**
 * Saves the chosen rows in one database transaction, tagged with a batch id
 * for undo. Only rows that passed validation can be saved; `include` lists the
 * row numbers to import (by default every new one, never duplicates).
 */
export async function commitImport(userId, target, preview, include) {
  const chosen = include ? new Set(include) : null;
  const rows = preview.rows.filter(
    (r) =>
      r.status !== 'error' && (chosen ? chosen.has(r.row) : r.status === 'ok'),
  );
  if (!rows.length) return { batchId: null, imported: 0 };
  const batchId = randomUUID();
  await sequelize.transaction(async (t) => {
    await Transaction.bulkCreate(
      rows.map((r) => ({
        UserId: userId,
        date: r.date,
        description: r.description,
        amount: r.amount,
        type: r.type,
        CategoryId: r.categoryId,
        paymentMethod: target.paymentMethod,
        AccountId: target.AccountId,
        CardId: target.CardId,
        importBatchId: batchId,
      })),
      { transaction: t, validate: true },
    );
  });
  // Imported expenses of this month may cross a budget threshold.
  const month = localToday().slice(0, 7);
  const touched = new Set(
    rows
      .filter(
        (r) => r.type === 'expense' && r.categoryId && r.date.startsWith(month),
      )
      .map((r) => r.categoryId),
  );
  for (const categoryId of touched)
    checkBudgetThresholds(userId, categoryId, localToday());
  return { batchId, imported: rows.length };
}

/** The user's import batches, newest first, for the undo list. */
export async function listBatches(userId) {
  const rows = await Transaction.findAll({
    attributes: [
      'importBatchId',
      [fn('COUNT', col('id')), 'count'],
      [fn('MIN', col('date')), 'from'],
      [fn('MAX', col('date')), 'to'],
      [fn('MAX', col('createdAt')), 'importedAt'],
      [fn('MAX', col('AccountId')), 'AccountId'],
      [fn('MAX', col('CardId')), 'CardId'],
    ],
    where: { UserId: userId, importBatchId: { [Op.ne]: null } },
    group: ['importBatchId'],
    order: [[fn('MAX', col('createdAt')), 'DESC']],
    limit: 20,
    raw: true,
  });
  return rows.map((r) => ({ ...r, count: Number(r.count) }));
}

/** Deletes every transaction of one batch of the user; returns how many. */
export const undoBatch = (userId, batchId) =>
  Transaction.destroy({ where: { UserId: userId, importBatchId: batchId } });
