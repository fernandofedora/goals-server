import { Category } from '../models/index.js';

/** The category itself plus its subcategories, for filters that roll children up. */
export async function withChildIds(userId, categoryId) {
  const children = await Category.findAll({
    where: { UserId: userId, parentId: categoryId },
    attributes: ['id'],
  });
  return [Number(categoryId), ...children.map((c) => c.id)];
}

const budgetOf = (category) =>
  category.monthlyBudget != null ? Number(category.monthlyBudget) : null;

/**
 * Totals of one transaction type grouped by top-level category, each with the
 * breakdown of its subcategories. A parent without its own budget uses the sum
 * of its children's budgets.
 */
export function groupByParent(txs, categories, type, fallbackColor) {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const childBudgets = new Map();
  for (const c of categories) {
    const budget = budgetOf(c);
    if (c.parentId && budget !== null) {
      childBudgets.set(
        c.parentId,
        (childBudgets.get(c.parentId) || 0) + budget,
      );
    }
  }

  const groups = new Map();
  for (const t of txs) {
    if (t.type !== type) continue;
    const amount = Number(t.amount);
    const category = t.CategoryId ? byId.get(t.CategoryId) : null;
    const parent = category?.parentId ? byId.get(category.parentId) : category;
    const key = parent?.id ?? 'none';

    if (!groups.has(key)) {
      groups.set(key, {
        id: parent?.id ?? null,
        name: parent?.name || 'Uncategorized',
        color: parent?.color || fallbackColor,
        amount: 0,
        monthlyBudget: parent
          ? (budgetOf(parent) ?? childBudgets.get(parent.id) ?? null)
          : null,
        children: [],
      });
    }
    const group = groups.get(key);
    group.amount += amount;

    if (category?.parentId) {
      let child = group.children.find((c) => c.id === category.id);
      if (!child) {
        child = {
          id: category.id,
          name: category.name,
          color: category.color,
          amount: 0,
          monthlyBudget: budgetOf(category),
        };
        group.children.push(child);
      }
      child.amount += amount;
    }
  }
  return [...groups.values()];
}
