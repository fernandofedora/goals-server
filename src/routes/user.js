import express from 'express';
import bcrypt from 'bcrypt';
import { authMiddleware } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { User } from '../models/index.js';
import { isStrongPassword } from '../utils/password.js';
import QRCode from 'qrcode';
import { generateSecret, otpauthUrl, verifyTotp } from '../utils/totp.js';
import {
  consumeRecoveryCode,
  decryptSecret,
  encryptSecret,
  generateRecoveryCodes,
  isTwoFactorConfigured,
  remainingRecoveryCodes,
} from '../utils/twoFactor.js';
import {
  UNSUBSCRIBE_LISTS,
  isValidUnsubscribeToken,
} from '../utils/unsubscribe.js';

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
      lastLoginAt: user.lastLoginAt,
      isSuperAdmin: user.isSuperAdmin,
      canAccessInvestments: user.canAccessInvestments,
      currency: user.currency || 'USD',
      language: user.language || 'en',
      budgetAlertsEnabled: user.budgetAlertsEnabled,
      monthlySummaryEnabled: user.monthlySummaryEnabled,
      twoFactorEnabled: user.twoFactorEnabled,
    });
  } catch (e) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.put(
  '/profile',
  authMiddleware,
  rateLimit((req) => `profile:${req.userId}`),
  async (req, res) => {
    try {
      const { name, email, currentPassword, currency, language } = req.body;
      const { budgetAlertsEnabled, monthlySummaryEnabled } = req.body;
      const user = await User.findByPk(req.userId);
      if (!user) return res.status(404).json({ message: 'User not found' });
      const updates = {};
      if (name) updates.name = name;
      if (currency) updates.currency = currency;
      if (language && ['en', 'es'].includes(language))
        updates.language = language;
      if (typeof budgetAlertsEnabled === 'boolean')
        updates.budgetAlertsEnabled = budgetAlertsEnabled;
      if (typeof monthlySummaryEnabled === 'boolean')
        updates.monthlySummaryEnabled = monthlySummaryEnabled;
      if (email && email !== user.email) {
        if (!currentPassword)
          return res
            .status(400)
            .json({ message: 'Current password required to change email' });
        const ok = await bcrypt.compare(currentPassword, user.passwordHash);
        if (!ok)
          return res.status(400).json({ message: 'Invalid current password' });
        updates.email = email;
      }
      await user.update(updates);
      res.json({
        publicId: user.publicId,
        name: user.name,
        email: user.email,
        currency: user.currency || 'USD',
        language: user.language || 'en',
        budgetAlertsEnabled: user.budgetAlertsEnabled,
      monthlySummaryEnabled: user.monthlySummaryEnabled,
      twoFactorEnabled: user.twoFactorEnabled,
      });
    } catch (e) {
      res.status(500).json({ message: 'Server error' });
    }
  },
);

router.post(
  '/change-password',
  authMiddleware,
  rateLimit((req) => `pwd:${req.userId}`),
  async (req, res) => {
    try {
      const { currentPassword, newPassword } = req.body;
      if (!currentPassword || !newPassword)
        return res
          .status(400)
          .json({ message: 'Current and new password required' });
      if (!isStrongPassword(newPassword))
        return res.status(400).json({ message: 'Weak password' });
      const user = await User.findByPk(req.userId);
      if (!user) return res.status(404).json({ message: 'User not found' });
      const ok = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!ok)
        return res.status(400).json({ message: 'Invalid current password' });
      const passwordHash = await bcrypt.hash(newPassword, 10);
      await user.update({ passwordHash });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ message: 'Server error' });
    }
  },
);

// ── Two-step sign-in (TOTP) ────────────────────────────────────────────────
const twoFactorLimit = rateLimit((req) => `2fa-setup:${req.userId}`, {
  limit: 10,
  windowMs: 15 * 60 * 1000,
});

router.get('/2fa', authMiddleware, async (req, res) => {
  const user = await User.findByPk(req.userId);
  if (!user) return res.status(404).json({ message: 'User not found' });
  res.json({
    enabled: user.twoFactorEnabled,
    available: isTwoFactorConfigured(),
    recoveryCodesLeft: user.twoFactorEnabled
      ? remainingRecoveryCodes(user.twoFactorRecoveryCodes)
      : 0,
  });
});

// Step 1: password again, then a new secret to scan. Not active until /enable.
router.post('/2fa/setup', authMiddleware, twoFactorLimit, async (req, res) => {
  try {
    if (!isTwoFactorConfigured())
      return res.status(503).json({ message: 'Two-factor is not available' });
    const user = await User.findByPk(req.userId);
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (user.twoFactorEnabled)
      return res.status(400).json({ message: 'Two-factor is already on' });
    const ok = await bcrypt.compare(String(req.body?.password || ''), user.passwordHash);
    if (!ok) return res.status(400).json({ message: 'Invalid current password' });

    const secret = generateSecret();
    await user.update({ twoFactorSecret: encryptSecret(secret), twoFactorLastStep: null });
    const url = otpauthUrl({ secret, account: user.email });
    res.json({ secret, otpauthUrl: url, qr: await QRCode.toDataURL(url, { margin: 1, width: 220 }) });
  } catch (e) {
    console.error('2FA setup failed:', e.message);
    res.status(500).json({ message: 'Server error' });
  }
});

// Step 2: the first code proves the app is set up. Returns the recovery
// codes; this is the only time they are shown.
router.post('/2fa/enable', authMiddleware, twoFactorLimit, async (req, res) => {
  try {
    const user = await User.findByPk(req.userId);
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (user.twoFactorEnabled)
      return res.status(400).json({ message: 'Two-factor is already on' });
    if (!user.twoFactorSecret)
      return res.status(400).json({ message: 'Invalid code' });
    const step = verifyTotp(decryptSecret(user.twoFactorSecret), req.body?.code);
    if (step === null) return res.status(400).json({ message: 'Invalid code' });

    const { codes, stored } = generateRecoveryCodes();
    await user.update({
      twoFactorEnabled: true,
      twoFactorLastStep: step,
      twoFactorRecoveryCodes: stored,
    });
    res.json({ enabled: true, recoveryCodes: codes });
  } catch (e) {
    console.error('2FA enable failed:', e.message);
    res.status(500).json({ message: 'Server error' });
  }
});

// Turning it off needs the password and a code (or a recovery code), so a
// stolen session alone can't remove it.
router.post('/2fa/disable', authMiddleware, twoFactorLimit, async (req, res) => {
  try {
    const user = await User.findByPk(req.userId);
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (!user.twoFactorEnabled) return res.json({ enabled: false });
    const { password, code, recoveryCode } = req.body || {};
    const ok = await bcrypt.compare(String(password || ''), user.passwordHash);
    if (!ok) return res.status(400).json({ message: 'Invalid current password' });
    const valid = recoveryCode
      ? consumeRecoveryCode(user.twoFactorRecoveryCodes, recoveryCode) !== null
      : verifyTotp(decryptSecret(user.twoFactorSecret), code, {
          lastStep: user.twoFactorLastStep,
        }) !== null;
    if (!valid) return res.status(400).json({ message: 'Invalid code' });

    await user.update({
      twoFactorEnabled: false,
      twoFactorSecret: null,
      twoFactorRecoveryCodes: null,
      twoFactorLastStep: null,
    });
    res.json({ enabled: false });
  } catch (e) {
    console.error('2FA disable failed:', e.message);
    res.status(500).json({ message: 'Server error' });
  }
});

// From the link in an email: no session, the signed token proves the link
// came from us. Answers the same for an unknown user and a bad token.
router.post(
  '/unsubscribe',
  rateLimit((req) => `unsubscribe:${req.ip}`, { limit: 20, windowMs: 15 * 60 * 1000 }),
  async (req, res) => {
    try {
      const { list, u, t } = req.body || {};
      if (!isValidUnsubscribeToken(list, u, t))
        return res.status(400).json({ message: 'Invalid link' });
      const user = await User.findOne({ where: { publicId: u } });
      if (!user) return res.status(400).json({ message: 'Invalid link' });
      await user.update({ [UNSUBSCRIBE_LISTS[list]]: false });
      res.json({ success: true, list });
    } catch (e) {
      res.status(500).json({ message: 'Server error' });
    }
  },
);

export default router;
