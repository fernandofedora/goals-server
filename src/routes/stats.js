import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { Transaction, Category, Card, Budget } from '../models/index.js';
import XLSX from 'xlsx';
import { Op } from 'sequelize'

const router = express.Router();
router.use(authMiddleware);

// Helper to get period filter
const periodFilter = (month, year) => {
  if (!month || !year) return {};
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 0);
  return { date: { $between: [start.toISOString().slice(0,10), end.toISOString().slice(0,10)] } };
};

router.get('/summary', async (req, res) => {
  try {
    const { period } = req.query;
    const where = { UserId: req.userId };

    // Parse period: 'all' or 'YYYY-MM'
    let month = null, year = null;
    if (period && period !== 'all') {
      const parts = String(period).split('-');
      year = Number(parts[0]); month = Number(parts[1]);
      if (!year || !month) return res.status(400).json({ message: 'Invalid period' });
      const start = `${year}-${String(month).padStart(2,'0')}-01`;
      const end = `${year}-${String(month).padStart(2,'0')}-${String(new Date(year, month, 0).getDate()).padStart(2,'0')}`;
      where.date = { [Op.between]: [start, end] };
    }

    const txs = await Transaction.findAll({ where, include: [Category, Card] });

    // Totals
    const income = txs.filter(t=>t.type==='income').reduce((a,b)=>a+Number(b.amount),0);
    const expense = txs.filter(t=>t.type==='expense').reduce((a,b)=>a+Number(b.amount),0);
    const totals = { income, expense, transactions: txs.length, balance: income - expense };

    // Categories (expenses only)
    const categoryMap = {};
    txs.filter(t=>t.type==='expense').forEach(t=>{
      const name = t.Category?.name || 'Uncategorized';
      const color = t.Category?.color || '#3b82f6';
      if (!categoryMap[name]) categoryMap[name] = { name, amount: 0, color };
      categoryMap[name].amount += Number(t.amount);
    });
    const categories = Object.values(categoryMap);

    // Income vs Expense timeseries (by day)
    const dayMap = {};
    txs.forEach(t=>{
      const d = t.date; // DATEONLY string 'YYYY-MM-DD'
      if (!dayMap[d]) dayMap[d] = { date: d, income: 0, expense: 0 };
      if (t.type === 'income') dayMap[d].income += Number(t.amount);
      else if (t.type === 'expense') dayMap[d].expense += Number(t.amount);
    });
    const incomeVsExpense = Object.values(dayMap).sort((a,b)=> a.date.localeCompare(b.date));

    // Payment methods breakdown (expenses only)
    const paymentMethods = {
      cash: txs.filter(t=>t.paymentMethod==='cash' && t.type==='expense').reduce((a,b)=>a+Number(b.amount),0),
      card: txs.filter(t=>t.paymentMethod==='card' && t.type==='expense').reduce((a,b)=>a+Number(b.amount),0)
    };

    // Per card breakdown (expenses only)
    const perCard = {};
    txs.filter(t=>t.paymentMethod==='card' && t.type==='expense').forEach(t=>{
      const name = t.Card?.name || 'Unknown';
      perCard[name] = (perCard[name]||0)+Number(t.amount);
    });

    // Budget amount for the selected month
    const budget = (month && year) ? await Budget.findOne({ where: { UserId: req.userId, month, year } }) : null;

    res.json({ totals, categories, incomeVsExpense, paymentMethods, perCard, budgetAmount: budget?.amount || null });
  } catch (e) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/export', async (req, res) => {
  try {
    const { period } = req.query;
    const where = { UserId: req.userId };
    if (period && period !== 'all') {
      const parts = String(period).split('-');
      const year = Number(parts[0]); const month = Number(parts[1]);
      if (!year || !month) return res.status(400).json({ message: 'Invalid period' });
      const start = `${year}-${String(month).padStart(2,'0')}-01`;
      const end = `${year}-${String(month).padStart(2,'0')}-${String(new Date(year, month, 0).getDate()).padStart(2,'0')}`;
      where.date = { [Op.between]: [start, end] };
    }

    const txs = await Transaction.findAll({ where, include: [Category, Card] });
    const rows = txs.map(t=>({
      Type: t.type,
      Description: t.description,
      Category: t.Category?.name || '',
      Amount: Number(t.amount),
      Date: t.date,
      PaymentMethod: t.paymentMethod,
      Card: t.Card?.name || ''
    }));

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Transactions');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename=transactions.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;