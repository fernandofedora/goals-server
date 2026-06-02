import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { Transaction, Category, Card, Budget, Account } from '../models/index.js';
import ExcelJS from 'exceljs';
import { Op } from 'sequelize'

const router = express.Router();
router.use(authMiddleware);

// Build a WHERE fragment that excludes transactions belonging to "no integrar"
// (isolated) accounts, while keeping transactions with no account (cash/card).
const excludeIsolatedAccounts = async (userId) => {
  const isolated = await Account.findAll({ where: { UserId: userId, isExcludedFromTotals: true }, attributes: ['id'] });
  const ids = isolated.map(a => a.id);
  if (ids.length === 0) return null;
  return { [Op.or]: [{ AccountId: null }, { AccountId: { [Op.notIn]: ids } }] };
};

// Helper to get period filter
const periodFilter = (month, year) => {
  if (!month || !year) return {};
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 0);
  return { date: { $between: [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)] } };
};

router.get('/summary', async (req, res) => {
  try {
    const { period, from, to } = req.query;
    const where = { UserId: req.userId };

    // Custom date range takes priority over period
    let month = null, year = null;
    if (from && to) {
      where.date = { [Op.between]: [from, to] };
    } else if (period && period !== 'all') {
      if (/^\d{4}$/.test(String(period))) {
        year = Number(period);
        where.date = { [Op.between]: [`${year}-01-01`, `${year}-12-31`] };
      } else {
        const parts = String(period).split('-');
        year = Number(parts[0]); month = Number(parts[1]);
        if (!year || !month) return res.status(400).json({ message: 'Invalid period' });
        const start = `${year}-${String(month).padStart(2, '0')}-01`;
        const end = `${year}-${String(month).padStart(2, '0')}-${String(new Date(year, month, 0).getDate()).padStart(2, '0')}`;
        where.date = { [Op.between]: [start, end] };
      }
    }

    // Exclude isolated ("no integrar") accounts from the general dashboard.
    const excludeFrag = await excludeIsolatedAccounts(req.userId);
    if (excludeFrag) Object.assign(where, excludeFrag);

    const txs = await Transaction.findAll({ where, include: [Category, Card, Account] });

    // Totals
    const income = txs.filter(t => t.type === 'income').reduce((a, b) => a + Number(b.amount), 0);
    const expense = txs.filter(t => t.type === 'expense').reduce((a, b) => a + Number(b.amount), 0);
    const totals = { income, expense, transactions: txs.length, balance: income - expense };

    // Categories (expenses only) — fetch all user categories to attach fixed monthlyBudget
    const allCategories = await Category.findAll({ where: { UserId: req.userId } });
    const catBudgetMap = Object.fromEntries(allCategories.map(c => [c.name, c.monthlyBudget != null ? Number(c.monthlyBudget) : null]));

    const categoryMap = {};
    txs.filter(t => t.type === 'expense').forEach(t => {
      const name = t.Category?.name || 'Uncategorized';
      const color = t.Category?.color || '#3b82f6';
      if (!categoryMap[name]) categoryMap[name] = { name, amount: 0, color, monthlyBudget: catBudgetMap[name] ?? null };
      categoryMap[name].amount += Number(t.amount);
    });
    const categories = Object.values(categoryMap);

    // Income vs Expense timeseries (by day)
    const dayMap = {};
    txs.forEach(t => {
      const d = t.date; // DATEONLY string 'YYYY-MM-DD'
      if (!dayMap[d]) dayMap[d] = { date: d, income: 0, expense: 0 };
      if (t.type === 'income') dayMap[d].income += Number(t.amount);
      else if (t.type === 'expense') dayMap[d].expense += Number(t.amount);
    });
    const incomeVsExpense = Object.values(dayMap).sort((a, b) => a.date.localeCompare(b.date));

    // Payment methods breakdown (expenses only)
    const paymentMethods = {
      cash: txs.filter(t => t.paymentMethod === 'cash' && t.type === 'expense').reduce((a, b) => a + Number(b.amount), 0),
      card: txs.filter(t => t.paymentMethod === 'card' && t.type === 'expense').reduce((a, b) => a + Number(b.amount), 0),
      account: txs.filter(t => t.paymentMethod === 'account' && t.type === 'expense').reduce((a, b) => a + Number(b.amount), 0)
    };

    // Per card breakdown (expenses only)
    const perCard = {};
    txs.filter(t => t.paymentMethod === 'card' && t.type === 'expense').forEach(t => {
      const name = t.Card?.name || 'Unknown';
      perCard[name] = (perCard[name] || 0) + Number(t.amount);
    });

    // Budget amount for the selected month
    const budget = (month && year) ? await Budget.findOne({ where: { UserId: req.userId, month, year } }) : null;

    // Income methods breakdown
    const incomeMethods = {
      cash: txs.filter(t => t.type === 'income' && t.paymentMethod === 'cash').reduce((a, b) => a + Number(b.amount), 0),
      account: txs.filter(t => t.type === 'income' && t.paymentMethod === 'account').reduce((a, b) => a + Number(b.amount), 0),
    };

    // Income categories (income by category)
    const incomeCategoryMap = {};
    txs.filter(t => t.type === 'income').forEach(t => {
      const name = t.Category?.name || 'Uncategorized';
      const color = t.Category?.color || '#10b981';
      if (!incomeCategoryMap[name]) incomeCategoryMap[name] = { name, amount: 0, color };
      incomeCategoryMap[name].amount += Number(t.amount);
    });
    const incomeCategories = Object.values(incomeCategoryMap);

    res.json({ totals, categories, incomeCategories, incomeVsExpense, paymentMethods, perCard, budgetAmount: budget?.amount || null, incomeMethods });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Server error' });
  }
});

// Monthly / daily evolution of one or more categories.
// Query: period (all|YYYY|YYYY-MM) or from+to, plus optional categoryIds (CSV).
router.get('/categories-timeline', async (req, res) => {
  try {
    const { period, from, to, categoryIds } = req.query;
    const userId = req.userId;

    // Parse explicit category filter (CSV → number[]).
    let catFilter = null;
    if (categoryIds) {
      const ids = String(categoryIds).split(',')
        .map(s => Number(s.trim()))
        .filter(n => Number.isInteger(n) && n > 0);
      if (ids.length > 0) catFilter = ids;
    }

    // Resolve which categories to render. Default: all of user's expense categories.
    const categoriesWhere = { UserId: userId };
    if (catFilter) categoriesWhere.id = catFilter;
    else categoriesWhere.type = 'expense';
    const cats = await Category.findAll({ where: categoriesWhere });
    const resolvedIds = cats.map(c => c.id);
    if (resolvedIds.length === 0) {
      return res.json({ granularity: 'month', series: [], categories: [] });
    }

    // Period parsing + granularity decision.
    const where = { UserId: userId, CategoryId: { [Op.in]: resolvedIds } };
    let granularity = 'month';
    let rangeStart = null, rangeEnd = null;

    if (from && to) {
      where.date = { [Op.between]: [from, to] };
      rangeStart = from; rangeEnd = to;
    } else if (period && period !== 'all') {
      if (/^\d{4}$/.test(String(period))) {
        const year = Number(period);
        rangeStart = `${year}-01-01`;
        rangeEnd = `${year}-12-31`;
        where.date = { [Op.between]: [rangeStart, rangeEnd] };
      } else if (/^\d{4}-\d{2}$/.test(String(period))) {
        const [yStr, mStr] = String(period).split('-');
        const year = Number(yStr), month = Number(mStr);
        if (!year || !month) return res.status(400).json({ message: 'Invalid period' });
        const lastDay = new Date(year, month, 0).getDate();
        rangeStart = `${year}-${String(month).padStart(2, '0')}-01`;
        rangeEnd = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
        where.date = { [Op.between]: [rangeStart, rangeEnd] };
        granularity = 'day';
      } else {
        return res.status(400).json({ message: 'Invalid period' });
      }
    }
    // else: period === 'all' (or unset) → no date filter, range derived from data.

    const txs = await Transaction.findAll({ where });

    // For all-time: derive range from data.
    if (!rangeStart || !rangeEnd) {
      if (txs.length === 0) {
        const today = new Date().toISOString().slice(0, 10);
        rangeStart = today; rangeEnd = today;
      } else {
        const dates = txs.map(t => t.date).filter(Boolean).sort();
        rangeStart = dates[0];
        rangeEnd = dates[dates.length - 1];
      }
    }

    // Build the bucket list (continuous, no gaps).
    const buckets = [];
    if (granularity === 'day') {
      const cur = new Date(`${rangeStart}T00:00:00Z`);
      const end = new Date(`${rangeEnd}T00:00:00Z`);
      while (cur <= end) {
        buckets.push(cur.toISOString().slice(0, 10));
        cur.setUTCDate(cur.getUTCDate() + 1);
      }
    } else {
      const [sy, sm] = rangeStart.slice(0, 7).split('-').map(Number);
      const [ey, em] = rangeEnd.slice(0, 7).split('-').map(Number);
      let y = sy, m = sm;
      while (y < ey || (y === ey && m <= em)) {
        buckets.push(`${y}-${String(m).padStart(2, '0')}`);
        m++;
        if (m > 12) { m = 1; y++; }
      }
    }

    // Initialize series: each bucket starts with 0 for every category.
    const seriesMap = {};
    buckets.forEach(b => {
      const obj = { period: b };
      resolvedIds.forEach(id => { obj[`cat_${id}`] = 0; });
      seriesMap[b] = obj;
    });

    // Aggregate amounts into buckets.
    txs.forEach(t => {
      const key = granularity === 'day' ? t.date : String(t.date || '').slice(0, 7);
      if (!seriesMap[key]) return;
      const catKey = `cat_${t.CategoryId}`;
      if (catKey in seriesMap[key]) {
        seriesMap[key][catKey] += Number(t.amount);
      }
    });

    const series = buckets.map(b => seriesMap[b]);
    const categories = cats.map(c => ({ id: c.id, name: c.name, color: c.color, type: c.type }));

    res.json({ granularity, series, categories });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/export', async (req, res) => {
  try {
    const { period, from, to } = req.query;
    const where = { UserId: req.userId };
    let selMonth = null, selYear = null;
    if (from && to) {
      where.date = { [Op.between]: [from, to] };
    } else if (period && period !== 'all') {
      if (/^\d{4}$/.test(String(period))) {
        selYear = Number(period);
        where.date = { [Op.between]: [`${selYear}-01-01`, `${selYear}-12-31`] };
      } else {
        const parts = String(period).split('-');
        selYear = Number(parts[0]); selMonth = Number(parts[1]);
        if (!selYear || !selMonth) return res.status(400).json({ message: 'Invalid period' });
        const start = `${selYear}-${String(selMonth).padStart(2, '0')}-01`;
        const end = `${selYear}-${String(selMonth).padStart(2, '0')}-${String(new Date(selYear, selMonth, 0).getDate()).padStart(2, '0')}`;
        where.date = { [Op.between]: [start, end] };
      }
    }

    // Exclude isolated ("no integrar") accounts from the export too.
    const excludeFrag = await excludeIsolatedAccounts(req.userId);
    if (excludeFrag) Object.assign(where, excludeFrag);

    // Load transactions
    const txs = await Transaction.findAll({ where, include: [Category, Card] });

    // Transactions sheet
    const transactionRows = txs.map(t => ({
      Type: t.type,
      Description: t.description,
      Category: t.Category?.name || '',
      Amount: Number(t.amount),
      Date: t.date,
      PaymentMethod: t.paymentMethod,
      Card: t.Card?.name || ''
    }));

    // Overview metrics
    const income = txs.filter(t => t.type === 'income').reduce((a, b) => a + Number(b.amount), 0);
    const expense = txs.filter(t => t.type === 'expense').reduce((a, b) => a + Number(b.amount), 0);
    const overviewRows = [
      { Metric: 'Income', Value: income },
      { Metric: 'Expense', Value: expense },
      { Metric: 'Transactions', Value: txs.length },
      { Metric: 'Balance', Value: income - expense }
    ];

    // Income vs Expenses by month
    const monthMap = {};
    txs.forEach(t => {
      const key = (t.date || '').slice(0, 7); // YYYY-MM
      if (!key) return;
      if (!monthMap[key]) monthMap[key] = { Month: key, Income: 0, Expense: 0 };
      if (t.type === 'income') monthMap[key].Income += Number(t.amount);
      else if (t.type === 'expense') monthMap[key].Expense += Number(t.amount);
    });
    const incomeVsExpenseRows = Object.values(monthMap).sort((a, b) => a.Month.localeCompare(b.Month));

    // Category totals (expenses only)
    const categoryMap = {};
    txs.filter(t => t.type === 'expense').forEach(t => {
      const name = t.Category?.name || 'Uncategorized';
      if (!categoryMap[name]) categoryMap[name] = { Category: name, Amount: 0 };
      categoryMap[name].Amount += Number(t.amount);
    });
    const categoryRows = Object.values(categoryMap);

    // Per card totals (expenses only)
    const perCardMap = {};
    txs.filter(t => t.paymentMethod === 'card' && t.type === 'expense').forEach(t => {
      const name = t.Card?.name || 'Unknown';
      perCardMap[name] = (perCardMap[name] || 0) + Number(t.amount);
    });
    const perCardRows = Object.entries(perCardMap).map(([Card, Amount]) => ({ Card, Amount }));

    // Budget vs Actual (only for a specific month)
    let budgetRows = [];
    if (selMonth && selYear) {
      const budgetItem = await Budget.findOne({ where: { UserId: req.userId, month: selMonth, year: selYear } });
      const budgetAmount = Number(budgetItem?.amount || 0);
      const actual = expense; // expenses already filtered for selected period
      const remaining = budgetAmount - actual;
      const consumedRatio = budgetAmount > 0 ? (actual / budgetAmount) : 0;
      budgetRows = [
        { Metric: 'Budget', Value: budgetAmount },
        { Metric: 'Actual (Expense)', Value: actual },
        { Metric: 'Remaining', Value: remaining },
        { Metric: 'Consumed %', Value: consumedRatio }
      ];
    } else {
      budgetRows = [{ Note: 'Budget vs Actual is only available for a specific month.' }];
    }

    // Build workbook with multiple sheets using ExcelJS with styling
    const wb = new ExcelJS.Workbook();

    // Helper to create a sheet from rows with headers in bold
    const createSheet = (name, columns, rows) => {
      const ws = wb.addWorksheet(name);
      ws.columns = columns;
      ws.addRows(rows);
      // Bold header
      const headerRow = ws.getRow(1);
      headerRow.font = { bold: true };
      return ws;
    };

    // Transactions
    const wsTransactions = createSheet('Transactions', [
      { header: 'Type', key: 'Type', width: 12 },
      { header: 'Description', key: 'Description', width: 32 },
      { header: 'Category', key: 'Category', width: 18 },
      { header: 'Amount', key: 'Amount', width: 14 },
      { header: 'Date', key: 'Date', width: 12 },
      { header: 'PaymentMethod', key: 'PaymentMethod', width: 16 },
      { header: 'Card', key: 'Card', width: 16 },
    ], transactionRows);
    wsTransactions.getColumn('Amount').numFmt = '0.00';

    // Overview
    const wsOverview = createSheet('Overview', [
      { header: 'Metric', key: 'Metric', width: 20 },
      { header: 'Value', key: 'Value', width: 16 },
    ], overviewRows);
    // Apply number format to Value column
    for (let r = 2; r <= wsOverview.rowCount; r++) {
      const metric = wsOverview.getCell(r, 1).value;
      const cell = wsOverview.getCell(r, 2);
      if (typeof cell.value === 'number') cell.numFmt = '0.00';
    }

    // Income vs Expenses
    const wsIncomeVsExpense = createSheet('IncomeVsExpenses', [
      { header: 'Month', key: 'Month', width: 10 },
      { header: 'Income', key: 'Income', width: 14 },
      { header: 'Expense', key: 'Expense', width: 14 },
    ], incomeVsExpenseRows);
    wsIncomeVsExpense.getColumn('Income').numFmt = '0.00';
    wsIncomeVsExpense.getColumn('Expense').numFmt = '0.00';

    // Categories
    const wsCategories = createSheet('Categories', [
      { header: 'Category', key: 'Category', width: 18 },
      { header: 'Amount', key: 'Amount', width: 14 },
    ], categoryRows);
    wsCategories.getColumn('Amount').numFmt = '0.00';

    // Budget vs Actual
    const wsBudget = createSheet('BudgetVsActual', [
      { header: 'Metric', key: 'Metric', width: 24 },
      { header: 'Value', key: 'Value', width: 16 },
    ], budgetRows);
    for (let r = 2; r <= wsBudget.rowCount; r++) {
      const metric = wsBudget.getCell(r, 1).value;
      const cell = wsBudget.getCell(r, 2);
      if (typeof cell.value === 'number') {
        if (String(metric).toLowerCase().includes('%')) cell.numFmt = '0.00%';
        else cell.numFmt = '0.00';
      }
    }

    // Per Card
    const wsPerCard = createSheet('PerCard', [
      { header: 'Card', key: 'Card', width: 18 },
      { header: 'Amount', key: 'Amount', width: 14 },
    ], perCardRows);
    wsPerCard.getColumn('Amount').numFmt = '0.00';

    const buf = await wb.xlsx.writeBuffer();
    const filename = (from && to)
      ? `transactions_${from}_to_${to}.xlsx`
      : (selYear && selMonth)
        ? `transactions_${String(selYear)}-${String(selMonth).padStart(2, '00')}.xlsx`
        : 'transactions_all.xlsx';
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(Buffer.from(buf));
  } catch (e) {
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;