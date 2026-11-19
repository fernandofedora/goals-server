import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { SavingsPlan, SavingsContribution, Category } from '../models/index.js';
import {
  isIsoDate,
  planProgress,
  planTotals,
} from '../utils/savingsProgress.js';
import { Op } from 'sequelize';

const router = express.Router();
router.use(authMiddleware);

const withCategory = {
  attributes: { exclude: ['UserId'] },
  include: [
    {
      model: Category,
      as: 'linkedCategory',
      attributes: { exclude: ['UserId'] },
    },
  ],
};

// Optional goal fields. undefined = not sent (keep current value on update).
function parseGoalFields(body) {
  const fields = {};
  if (body.targetDate !== undefined) {
    if (body.targetDate === null || body.targetDate === '')
      fields.targetDate = null;
    else if (isIsoDate(body.targetDate)) fields.targetDate = body.targetDate;
    else return { error: true };
  }
  if (body.initialAmount !== undefined) {
    const amount =
      body.initialAmount === '' || body.initialAmount === null
        ? 0
        : Number(body.initialAmount);
    if (!Number.isFinite(amount) || amount < 0) return { error: true };
    fields.initialAmount = amount;
  }
  return { fields };
}

// Listar planes del usuario, cada uno con su estado frente a la fecha objetivo
router.get('/plans', async (req, res) => {
  const plans = await SavingsPlan.findAll({
    where: { UserId: req.userId },
    ...withCategory,
    order: [['updatedAt', 'DESC']],
  });
  const withProgress = await Promise.all(
    plans.map(async (p) => ({
      ...p.toJSON(),
      progress: await planProgress(p, req.userId),
    })),
  );
  res.json(withProgress);
});

// Crear plan
router.post('/plans', async (req, res) => {
  const { name, targetAmount, linkedCategoryId } = req.body;
  const goal = parseGoalFields(req.body);
  if (!name || !targetAmount || Number(targetAmount) <= 0 || goal.error) {
    return res.status(400).json({ message: 'Datos inválidos' });
  }
  let categoryId = linkedCategoryId || null;
  if (categoryId) {
    const cat = await Category.findOne({
      where: { id: categoryId, UserId: req.userId },
    });
    if (!cat)
      return res.status(403).json({ message: 'Categoría no permitida' });
  }
  const plan = await SavingsPlan.create({
    name,
    targetAmount,
    UserId: req.userId,
    linkedCategoryId: categoryId,
    ...goal.fields,
  });
  const full = await SavingsPlan.findByPk(plan.id, withCategory);
  res.json({
    ...full.toJSON(),
    progress: await planProgress(full, req.userId),
  });
});

// Actualizar plan
router.put('/plans/:id', async (req, res) => {
  const plan = await SavingsPlan.findOne({
    where: { id: req.params.id, UserId: req.userId },
  });
  if (!plan) return res.status(404).json({ message: 'Plan no encontrado' });
  const { name, targetAmount, linkedCategoryId, status } = req.body;
  const goal = parseGoalFields(req.body);
  if (!name || !targetAmount || Number(targetAmount) <= 0 || goal.error) {
    return res.status(400).json({ message: 'Datos inválidos' });
  }
  let categoryId =
    linkedCategoryId === undefined
      ? plan.linkedCategoryId
      : linkedCategoryId || null;
  if (categoryId) {
    const cat = await Category.findOne({
      where: { id: categoryId, UserId: req.userId },
    });
    if (!cat)
      return res.status(403).json({ message: 'Categoría no permitida' });
  }
  await plan.update({
    name,
    targetAmount,
    status,
    linkedCategoryId: categoryId,
    ...goal.fields,
  });
  const full = await SavingsPlan.findByPk(plan.id, withCategory);
  res.json({
    ...full.toJSON(),
    progress: await planProgress(full, req.userId),
  });
});

// Detalle de plan
router.get('/plans/:id', async (req, res) => {
  const plan = await SavingsPlan.findOne({
    where: { id: req.params.id, UserId: req.userId },
    ...withCategory,
  });
  if (!plan) return res.status(404).json({ message: 'Plan no encontrado' });
  res.json(plan);
});

// (Opcional) eliminar/archivar plan
router.delete('/plans/:id', async (req, res) => {
  const plan = await SavingsPlan.findOne({
    where: { id: req.params.id, UserId: req.userId },
  });
  if (!plan) return res.status(404).json({ message: 'Plan no encontrado' });
  await plan.destroy();
  res.json({ success: true });
});

// Crear contribución manual
router.post('/contributions', async (req, res) => {
  const { planId, amount, date, note } = req.body;
  if (!planId || !amount || Number(amount) <= 0 || !date) {
    return res.status(400).json({ message: 'Datos inválidos' });
  }
  const plan = await SavingsPlan.findOne({
    where: { id: planId, UserId: req.userId },
  });
  if (!plan) return res.status(403).json({ message: 'Plan no permitido' });
  const contr = await SavingsContribution.create({
    planId,
    amount,
    date,
    note: note || null,
    UserId: req.userId,
  });
  const plain = contr.toJSON();
  delete plain.UserId;
  res.json(plain);
});

// Actualizar contribución manual
router.put('/contributions/:id', async (req, res) => {
  const contr = await SavingsContribution.findOne({
    where: { id: req.params.id, UserId: req.userId },
    include: [{ model: SavingsPlan, attributes: { exclude: ['UserId'] } }],
  });
  if (!contr)
    return res.status(404).json({ message: 'Contribución no encontrada' });
  const { amount, date, note } = req.body;
  await contr.update({ amount, date, note: note ?? contr.note });
  const plainUpd = contr.toJSON();
  delete plainUpd.UserId;
  res.json(plainUpd);
});

// Eliminar contribución manual
router.delete('/contributions/:id', async (req, res) => {
  const contr = await SavingsContribution.findOne({
    where: { id: req.params.id, UserId: req.userId },
  });
  if (!contr)
    return res.status(404).json({ message: 'Contribución no encontrada' });
  await contr.destroy();
  res.json({ success: true });
});

// Resumen y progreso del plan
router.get('/plans/:id/summary', async (req, res) => {
  const { from, to } = req.query;
  const plan = await SavingsPlan.findOne({
    where: { id: req.params.id, UserId: req.userId },
  });
  if (!plan) return res.status(404).json({ message: 'Plan no encontrado' });

  const range = {};
  if (from || to) {
    range.date = {};
    if (from) range.date[Op.gte] = from;
    if (to) range.date[Op.lte] = to;
  }

  const totals = await planTotals(plan, req.userId, range);
  const target = Number(plan.targetAmount);
  const progressPercent =
    target > 0 ? Math.min(100, (totals.saved / target) * 100) : 0;
  const remaining = Math.max(0, target - totals.saved);
  // The goal status always looks at all-time totals, whatever the window.
  const { status, suggestedMonthly, expected } = await planProgress(
    plan,
    req.userId,
  );

  res.json({
    totalManual: totals.totalManual,
    totalAuto: totals.totalAuto,
    initialAmount: totals.initialAmount,
    progressPercent,
    remaining,
    status,
    suggestedMonthly,
    expected,
    contributions: totals.contributions,
    autoTransactions: totals.autoTransactions.map((t) => ({
      id: t.id,
      amount: t.amount,
      date: t.date,
      description: t.description,
      source: 'auto',
    })),
  });
});

export default router;
