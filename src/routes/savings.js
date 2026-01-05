import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { SavingsPlan, SavingsContribution, Category, Transaction } from '../models/index.js';
import { Op } from 'sequelize';

const router = express.Router();
router.use(authMiddleware);

// Listar planes del usuario
router.get('/plans', async (req, res) => {
  const plans = await SavingsPlan.findAll({
    where: { UserId: req.userId },
    attributes: { exclude: ['UserId'] },
    include: [{ model: Category, as: 'linkedCategory', attributes: { exclude: ['UserId'] } }],
    order: [['updatedAt', 'DESC']]
  });
  res.json(plans);
});

// Crear plan
router.post('/plans', async (req, res) => {
  const { name, targetAmount, linkedCategoryId } = req.body;
  if (!name || !targetAmount || Number(targetAmount) <= 0) {
    return res.status(400).json({ message: 'Datos inválidos' });
  }
  let categoryId = linkedCategoryId || null;
  if (categoryId) {
    const cat = await Category.findOne({ where: { id: categoryId, UserId: req.userId } });
    if (!cat) return res.status(403).json({ message: 'Categoría no permitida' });
  }
  const plan = await SavingsPlan.create({ name, targetAmount, UserId: req.userId, linkedCategoryId: categoryId });
  const full = await SavingsPlan.findByPk(plan.id, { attributes: { exclude: ['UserId'] }, include: [{ model: Category, as: 'linkedCategory', attributes: { exclude: ['UserId'] } }] });
  res.json(full);
});

// Actualizar plan
router.put('/plans/:id', async (req, res) => {
  const plan = await SavingsPlan.findOne({ where: { id: req.params.id, UserId: req.userId } });
  if (!plan) return res.status(404).json({ message: 'Plan no encontrado' });
  const { name, targetAmount, linkedCategoryId, status } = req.body;
  let categoryId = linkedCategoryId === undefined ? plan.linkedCategoryId : (linkedCategoryId || null);
  if (categoryId) {
    const cat = await Category.findOne({ where: { id: categoryId, UserId: req.userId } });
    if (!cat) return res.status(403).json({ message: 'Categoría no permitida' });
  }
  await plan.update({ name, targetAmount, status, linkedCategoryId: categoryId });
  const full = await SavingsPlan.findByPk(plan.id, { include: [{ model: Category, as: 'linkedCategory' }] });
  res.json(full);
});

// Detalle de plan
router.get('/plans/:id', async (req, res) => {
  const plan = await SavingsPlan.findOne({ where: { id: req.params.id, UserId: req.userId }, attributes: { exclude: ['UserId'] }, include: [{ model: Category, as: 'linkedCategory', attributes: { exclude: ['UserId'] } }] });
  if (!plan) return res.status(404).json({ message: 'Plan no encontrado' });
  res.json(plan);
});

// (Opcional) eliminar/archivar plan
router.delete('/plans/:id', async (req, res) => {
  const plan = await SavingsPlan.findOne({ where: { id: req.params.id, UserId: req.userId } });
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
  const plan = await SavingsPlan.findOne({ where: { id: planId, UserId: req.userId } });
  if (!plan) return res.status(403).json({ message: 'Plan no permitido' });
  const contr = await SavingsContribution.create({ planId, amount, date, note: note || null, UserId: req.userId });
  const plain = contr.toJSON();
  delete plain.UserId;
  res.json(plain);
});

// Actualizar contribución manual
router.put('/contributions/:id', async (req, res) => {
  const contr = await SavingsContribution.findOne({ where: { id: req.params.id, UserId: req.userId }, include: [{ model: SavingsPlan, attributes: { exclude: ['UserId'] } }] });
  if (!contr) return res.status(404).json({ message: 'Contribución no encontrada' });
  const { amount, date, note } = req.body;
  await contr.update({ amount, date, note: note ?? contr.note });
  const plainUpd = contr.toJSON();
  delete plainUpd.UserId;
  res.json(plainUpd);
});

// Eliminar contribución manual
router.delete('/contributions/:id', async (req, res) => {
  const contr = await SavingsContribution.findOne({ where: { id: req.params.id, UserId: req.userId } });
  if (!contr) return res.status(404).json({ message: 'Contribución no encontrada' });
  await contr.destroy();
  res.json({ success: true });
});

// Resumen y progreso del plan
router.get('/plans/:id/summary', async (req, res) => {
  const { from, to } = req.query;
  const plan = await SavingsPlan.findOne({ where: { id: req.params.id, UserId: req.userId } });
  if (!plan) return res.status(404).json({ message: 'Plan no encontrado' });

  const range = {};
  if (from || to) {
    range.date = {};
    if (from) range.date[Op.gte] = from;
    if (to) range.date[Op.lte] = to;
  }

  const manual = await SavingsContribution.findAll({ where: { planId: plan.id, ...(range.date ? { date: range.date } : {}) } });
  const totalManual = manual.reduce((sum, c) => sum + Number(c.amount), 0);

  let totalAuto = 0;
  let autoTransactions = [];
  if (plan.linkedCategoryId) {
    const where = { UserId: req.userId, CategoryId: plan.linkedCategoryId, type: 'expense', ...(range.date ? { date: range.date } : {}) };
    autoTransactions = await Transaction.findAll({ where, order: [['date','DESC']] });
    totalAuto = autoTransactions.reduce((s, t) => s + Number(t.amount), 0);
  }

  const total = totalManual + totalAuto;
  const target = Number(plan.targetAmount);
  const progressPercent = target > 0 ? Math.min(100, (total / target) * 100) : 0;
  const remaining = Math.max(0, target - total);

  res.json({
    totalManual,
    totalAuto,
    progressPercent,
    remaining,
    contributions: manual,
    autoTransactions: autoTransactions.map(t => ({ id: t.id, amount: t.amount, date: t.date, description: t.description, source: 'auto' }))
  });
});

export default router;
