import express from 'express';
import bcrypt from 'bcrypt';
import { authMiddleware } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { User } from '../models/index.js';

const router = express.Router();

router.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findByPk(req.userId);
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json({
      publicId: user.publicId,
      name: user.name,
      email: user.email,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt
    });
  } catch (e) { res.status(500).json({ message: 'Server error' }); }
});

router.put('/profile', authMiddleware, rateLimit((req) => `profile:${req.userId}`), async (req, res) => {
  try {
    const { name, email, currentPassword } = req.body;
    const user = await User.findByPk(req.userId);
    if (!user) return res.status(404).json({ message: 'User not found' });
    const updates = {};
    if (name) updates.name = name;
    if (email && email !== user.email) {
      if (!currentPassword) return res.status(400).json({ message: 'Current password required to change email' });
      const ok = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!ok) return res.status(400).json({ message: 'Invalid current password' });
      updates.email = email;
    }
    await user.update(updates);
    res.json({ publicId: user.publicId, name: user.name, email: user.email });
  } catch (e) { res.status(500).json({ message: 'Server error' }); }
});

router.post('/change-password', authMiddleware, rateLimit((req) => `pwd:${req.userId}`), async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ message: 'Current and new password required' });
    const strong = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\\d).{8,}$/.test(newPassword);
    if (!strong) return res.status(400).json({ message: 'Weak password' });
    const user = await User.findByPk(req.userId);
    if (!user) return res.status(404).json({ message: 'User not found' });
    const ok = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!ok) return res.status(400).json({ message: 'Invalid current password' });
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await user.update({ passwordHash });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ message: 'Server error' }); }
});

export default router;
