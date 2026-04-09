import express from 'express';
import bcrypt from 'bcrypt';
import { Op } from 'sequelize';
import { sequelize } from '../config/db.js';
import { authMiddleware, superAdminMiddleware } from '../middleware/auth.js';
import {
  User, Category, Transaction, Card, Budget,
  SavingsPlan, SavingsContribution, Account, ScheduledPayment
} from '../models/index.js';

const router = express.Router();

// All routes below require valid JWT + Super Admin role (checked in DB)
router.use(authMiddleware, superAdminMiddleware);

// ─── GET /api/admin/users ────────────────────────────────────────────────────
// List all users with optional search + pagination
router.get('/users', async (req, res) => {
  try {
    const { search = '', page = 1, limit = 20, status, role } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const where = {};

    if (search) {
      where[Op.or] = [
        { name: { [Op.like]: `%${search}%` } },
        { email: { [Op.like]: `%${search}%` } }
      ];
    }

    if (status === 'active') where.isActive = true;
    if (status === 'inactive') where.isActive = false;
    if (role === 'superadmin') where.isSuperAdmin = true;
    if (role === 'user') where.isSuperAdmin = false;

    const { count, rows } = await User.findAndCountAll({
      where,
      attributes: ['id', 'publicId', 'name', 'email', 'isActive', 'isSuperAdmin', 'lastLoginAt', 'createdAt'],
      order: [['createdAt', 'DESC']],
      limit: parseInt(limit),
      offset
    });

    res.json({
      total: count,
      page: parseInt(page),
      limit: parseInt(limit),
      pages: Math.ceil(count / parseInt(limit)),
      users: rows
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── GET /api/admin/users/:id ────────────────────────────────────────────────
router.get('/users/:id', async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id, {
      attributes: ['id', 'publicId', 'name', 'email', 'isActive', 'isSuperAdmin', 'lastLoginAt', 'createdAt']
    });
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json(user);
  } catch (e) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── PATCH /api/admin/users/:id ──────────────────────────────────────────────
// Edit name and/or email of a user
router.patch('/users/:id', async (req, res) => {
  try {
    const { name, email } = req.body;
    const user = await User.findByPk(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const updates = {};
    if (name) updates.name = name;
    if (email && email !== user.email) {
      const existing = await User.findOne({ where: { email } });
      if (existing) return res.status(400).json({ message: 'Email already in use' });
      updates.email = email;
    }

    await user.update(updates);
    res.json({
      id: user.id, publicId: user.publicId, name: user.name,
      email: user.email, isActive: user.isActive, isSuperAdmin: user.isSuperAdmin
    });
  } catch (e) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── PATCH /api/admin/users/:id/status ──────────────────────────────────────
// Activate or deactivate a user (soft disable)
router.patch('/users/:id/status', async (req, res) => {
  try {
    const { isActive } = req.body;
    if (typeof isActive !== 'boolean') return res.status(400).json({ message: 'isActive must be boolean' });

    const user = await User.findByPk(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    // Prevent Super Admin from disabling themselves
    if (user.id === req.userId && !isActive) {
      return res.status(400).json({ message: 'You cannot deactivate your own account' });
    }

    await user.update({ isActive });
    res.json({ id: user.id, isActive: user.isActive });
  } catch (e) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── POST /api/admin/users/:id/reset-password ────────────────────────────────
// Generate and set a temporary password (no SMTP yet — returned in response)
router.post('/users/:id/reset-password', async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    // Generate a secure 12-char temporary password: letters + digits + symbol
    const charset = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$';
    let tempPassword = '';
    for (let i = 0; i < 12; i++) {
      tempPassword += charset[Math.floor(Math.random() * charset.length)];
    }

    const passwordHash = await bcrypt.hash(tempPassword, 10);
    await user.update({ passwordHash });

    res.json({
      success: true,
      tempPassword,  // shown once in the frontend modal – will be replaced by email when SMTP is added
      message: `Temporary password set for ${user.name}. Share it securely.`
    });
  } catch (e) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── PATCH /api/admin/users/:id/promote ──────────────────────────────────────
// Grant or revoke Super Admin role
router.patch('/users/:id/promote', async (req, res) => {
  try {
    const { isSuperAdmin } = req.body;
    if (typeof isSuperAdmin !== 'boolean') return res.status(400).json({ message: 'isSuperAdmin must be boolean' });

    const user = await User.findByPk(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    // Prevent SA from revoking their own role
    if (user.id === req.userId && !isSuperAdmin) {
      return res.status(400).json({ message: 'You cannot remove your own Super Admin role' });
    }

    await user.update({ isSuperAdmin });
    res.json({ id: user.id, isSuperAdmin: user.isSuperAdmin });
  } catch (e) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── DELETE /api/admin/users/:id ─────────────────────────────────────────────
// Permanently delete a user and ALL their data (cascade)
router.delete('/users/:id', async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    if (user.id === req.userId) {
      return res.status(400).json({ message: 'You cannot delete your own account' });
    }

    const userId = user.id;

    // Cascade delete in dependency order to avoid FK constraint errors
    await sequelize.transaction(async (t) => {
      // Contributions → Plans
      const plans = await SavingsPlan.findAll({ where: { UserId: userId }, transaction: t });
      for (const plan of plans) {
        await SavingsContribution.destroy({ where: { planId: plan.id }, transaction: t });
      }
      await SavingsPlan.destroy({ where: { UserId: userId }, transaction: t });

      // Transactions (before categories & accounts)
      await Transaction.destroy({ where: { UserId: userId }, transaction: t });

      // Scheduled Payments
      await ScheduledPayment.destroy({ where: { UserId: userId }, transaction: t });

      // Budgets
      await Budget.destroy({ where: { UserId: userId }, transaction: t });

      // Categories
      await Category.destroy({ where: { UserId: userId }, transaction: t });

      // Cards
      await Card.destroy({ where: { UserId: userId }, transaction: t });

      // Accounts
      await Account.destroy({ where: { UserId: userId }, transaction: t });

      // Finally, the user
      await user.destroy({ transaction: t });
    });

    res.json({ success: true, message: `User "${user.name}" and all their data have been permanently deleted.` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Server error during deletion' });
  }
});

export default router;
