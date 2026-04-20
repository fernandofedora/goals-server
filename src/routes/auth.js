import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { User, Category } from '../models/index.js';

const router = express.Router();

router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    const existing = await User.findOne({ where: { email } });
    if (existing) return res.status(400).json({ message: 'Email already registered' });
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({ name, email, passwordHash });

    try {
      const defaults = [
        { name: 'Housing', color: '#8b5cf6', type: 'expense', UserId: user.id },
        { name: 'Food', color: '#f59e0b', type: 'expense', UserId: user.id },
        { name: 'Transportation', color: '#3b82f6', type: 'expense', UserId: user.id },
        { name: 'Utilities', color: '#06b6d4', type: 'expense', UserId: user.id },
        { name: 'Entertainment', color: '#ec4899', type: 'expense', UserId: user.id },
        { name: 'Healthcare', color: '#10b981', type: 'expense', UserId: user.id },
        { name: 'Salary', color: '#10b981', type: 'income', UserId: user.id }
      ];
      await Category.bulkCreate(defaults);
    } catch (err) {
      console.error('Failed to create default categories for new user:', err);
    }
    res.json({ publicId: user.publicId, name: user.name, email: user.email });
  } catch (e) { res.status(500).json({ message: 'Server error' }); }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ where: { email } });
    if (!user) return res.status(400).json({ message: 'Invalid credentials' });
    if (!user.isActive) return res.status(403).json({ message: 'Account disabled. Contact an administrator.' });
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(400).json({ message: 'Invalid credentials' });
    const token = jwt.sign({ id: user.id, isSuperAdmin: user.isSuperAdmin }, process.env.SECRET_KEY, { expiresIn: '7d' });
    const now = new Date();
    await user.update({ lastLoginAt: now });
    res.json({ token, user: { publicId: user.publicId, name: user.name, email: user.email, createdAt: user.createdAt, lastLoginAt: now, isSuperAdmin: user.isSuperAdmin } });
  } catch (e) { res.status(500).json({ message: 'Server error' }); }
});

// Start password reset: verify email exists
router.post('/reset-start', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: 'Email required' });
    const user = await User.findOne({ where: { email } });
    res.json({ exists: !!user });
  } catch (e) { res.status(500).json({ message: 'Server error' }); }
});

// Complete password reset: update password for given email
router.post('/reset', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Email and password required' });
    const user = await User.findOne({ where: { email } });
    if (!user) return res.status(404).json({ message: 'Email not found' });
    const passwordHash = await bcrypt.hash(password, 10);
    await user.update({ passwordHash });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ message: 'Server error' }); }
});

// ─── POST /api/auth/bootstrap ───────────────────────────────────────────────
// One-time route to promote an existing user to Super Admin.
// Requires the BOOTSTRAP_SECRET env variable as the Authorization header value.
router.post('/bootstrap', async (req, res) => {
  try {
    const secret = req.headers.authorization;
    if (!secret || secret !== process.env.BOOTSTRAP_SECRET) {
      return res.status(403).json({ message: 'Invalid bootstrap secret' });
    }
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: 'Email required' });
    const user = await User.findOne({ where: { email } });
    if (!user) return res.status(404).json({ message: 'User not found' });
    await user.update({ isSuperAdmin: true, isActive: true });
    res.json({ success: true, message: `${user.name} (${user.email}) is now a Super Admin.` });
  } catch (e) { res.status(500).json({ message: 'Server error' }); }
});

export default router;
