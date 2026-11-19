import { Category, CategoryRule } from '../models/index.js';

export const MAX_RULES_PER_USER = 200;
const MAX_AMOUNT = 999999999.99;

const OPERATORS = {
  description: ['contains', 'notContains', 'equals', 'startsWith'],
  amount: ['equals', 'gt', 'lt'],
};

// Control characters never belong in a name or a pattern.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const cleanText = (value) =>
  String(value ?? '')
    .replace(CONTROL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Case- and accent-insensitive form used for every text comparison. */
export const normalizeText = (value) =>
  cleanText(value).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const invalid = (code, message) => ({ error: { code, message } });

/**
 * Checks a rule from the request body. Returns `{ fields }` ready to store or
 * `{ error: { code, message } }`. `current` holds the stored rule on updates.
 */
export function validateRule(body, current = {}) {
  const pick = (key) => (body[key] !== undefined ? body[key] : current[key]);

  const name = cleanText(pick('name'));
  if (!name || name.length > 80) {
    return invalid(
      'RULE_INVALID_NAME',
      'El nombre debe tener entre 1 y 80 caracteres.',
    );
  }

  const field = pick('field');
  if (!OPERATORS[field])
    return invalid('RULE_INVALID_FIELD', 'Campo no válido.');
  const operator = pick('operator');
  if (!OPERATORS[field].includes(operator)) {
    return invalid(
      'RULE_INVALID_OPERATOR',
      'Condición no válida para ese campo.',
    );
  }

  let value = pick('value');
  if (field === 'amount') {
    const amount = Number(String(value ?? '').trim());
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
      return invalid(
        'RULE_INVALID_AMOUNT',
        'El monto debe ser un número mayor que 0.',
      );
    }
    value = String(Math.round(amount * 100) / 100);
  } else {
    value = cleanText(value);
    if (!value || value.length > 100) {
      return invalid(
        'RULE_INVALID_TEXT',
        'El texto debe tener entre 1 y 100 caracteres.',
      );
    }
  }

  const isActive = pick('isActive');
  return {
    fields: {
      name,
      field,
      operator,
      value,
      isActive: isActive === undefined ? true : Boolean(isActive),
    },
  };
}

/** Whether a rule's condition holds for a transaction `{ description, amount }`. */
export function ruleMatches(rule, tx) {
  if (rule.field === 'amount') {
    const amount = Number(tx.amount);
    const target = Number(rule.value);
    if (!Number.isFinite(amount)) return false;
    if (rule.operator === 'gt') return amount > target;
    if (rule.operator === 'lt') return amount < target;
    return Math.round(amount * 100) === Math.round(target * 100);
  }
  const text = normalizeText(tx.description);
  const pattern = normalizeText(rule.value);
  switch (rule.operator) {
    case 'contains':
      return text.includes(pattern);
    case 'notContains':
      return !text.includes(pattern);
    case 'equals':
      return text === pattern;
    case 'startsWith':
      return text.startsWith(pattern);
    default:
      return false;
  }
}

/** An expense can't land in an income category; transfer categories fit both. */
export const categoryFits = (category, txType) =>
  Boolean(category) &&
  (category.type === txType || category.type === 'transfer');

/** Active rules of a user, highest priority (lowest number) first. */
export const loadRules = (userId) =>
  CategoryRule.findAll({
    where: { UserId: userId, isActive: true },
    include: [{ model: Category, attributes: ['id', 'name', 'type'] }],
    order: [
      ['priority', 'ASC'],
      ['id', 'ASC'],
    ],
  });

/** First rule that matches and whose category fits the transaction type. */
export function pickRule(rules, tx) {
  return (
    rules.find(
      (rule) => categoryFits(rule.Category, tx.type) && ruleMatches(rule, tx),
    ) || null
  );
}

/** Category the user's rules give a transaction, or null. */
export async function applyRules(userId, tx, rules = null) {
  const rule = pickRule(rules ?? (await loadRules(userId)), tx);
  return rule ? rule.CategoryId : null;
}
