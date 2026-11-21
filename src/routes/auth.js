import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { Op } from 'sequelize';
import { User } from '../models/index.js';
import { addSuggestedCategories } from '../utils/categoryCatalog.js';
import { sendVerificationEmail, sendResetPasswordEmail } from '../utils/mail.js';
import { rateLimit, bodyEmail } from '../middleware/rateLimit.js';
import { hashResetToken, isAcceptablePassword } from '../utils/password.js';

const router = express.Router();

const MINUTE = 60 * 1000;
const RESET_TOKEN_TTL_MS = 60 * MINUTE;
const RESET_START_MESSAGE = 'Si el correo existe, se enviará un enlace de recuperación.';

// Compared against when the email does not exist, so a failed login takes
// about as long for unknown emails as for known ones.
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer', 10);

const byIp = (scope, limit, windowMs) =>
  rateLimit((req) => `${scope}:ip:${req.ip}`, { limit, windowMs });
const byEmail = (scope, limit, windowMs) =>
  rateLimit((req) => `${scope}:email:${bodyEmail(req)}`, { limit, windowMs });

router.post('/register', byIp('register', 10, 60 * MINUTE), async (req, res) => {
  try {
    const { name, email, password, language } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ message: 'Datos inválidos' });
    if (!isAcceptablePassword(password))
      return res.status(400).json({ message: 'Weak password' });

    const existing = await User.findOne({ where: { email } });
    if (existing) return res.status(400).json({ message: 'El correo electrónico ya está registrado' });

    const passwordHash = await bcrypt.hash(password, 10);
    const verificationToken = uuidv4();

    const user = await User.create({
      name,
      email,
      passwordHash,
      isEmailVerified: false,
      verificationToken,
      // The categories catalog is created in this language.
      ...(['es', 'en'].includes(language) ? { language } : {}),
    });

    try {
      await addSuggestedCategories(user.id, user.language);
    } catch (err) {
      console.error('Failed to create default categories for new user:', err);
    }

    try {
      await sendVerificationEmail(email, name, verificationToken);
    } catch (mailErr) {
      console.error('Failed to send verification email:', mailErr);
      // We still registered the user, but they might need a way to resend the email
    }

    res.json({ message: 'Registro exitoso. Por favor verifica tu correo electrónico.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

router.post(
  '/login',
  byIp('login', 30, 15 * MINUTE),
  byEmail('login', 10, 15 * MINUTE),
  async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Credenciales inválidas' });
    const user = await User.findOne({ where: { email } });
    // Check the password before the account status, so "deactivated" and
    // "verify your email" only tell an account exists to its owner.
    const ok = await bcrypt.compare(String(password), user ? user.passwordHash : DUMMY_HASH);
    if (!user || !ok) return res.status(400).json({ message: 'Credenciales inválidas' });
    if (!user.isActive) return res.status(403).json({ message: 'Cuenta desactivada. Contacta a un administrador.' });
    if (!user.isEmailVerified) return res.status(403).json({ message: 'Por favor verifica tu correo electrónico para iniciar sesión.' });

    const token = jwt.sign({ id: user.id, isSuperAdmin: user.isSuperAdmin }, process.env.SECRET_KEY, { expiresIn: '7d' });
    const now = new Date();
    await user.update({ lastLoginAt: now });
    res.json({ token, user: { publicId: user.publicId, name: user.name, email: user.email, createdAt: user.createdAt, lastLoginAt: now, isSuperAdmin: user.isSuperAdmin, canAccessInvestments: user.canAccessInvestments } });
  } catch (e) { res.status(500).json({ message: 'Error del servidor' }); }
  },
);

router.get('/verify-email/:token', byIp('verify', 30, 15 * MINUTE), async (req, res) => {
  try {
    const { token } = req.params;
    if (!token) return res.status(400).json({ message: 'Token requerido' });

    const user = await User.findOne({ where: { verificationToken: token } });

    if (!user) {
      return res.status(400).json({ message: 'El enlace es inválido o ya ha sido utilizado.' });
    }

    await user.update({ isEmailVerified: true, verificationToken: null });
    res.json({ message: 'Cuenta verificada exitosamente. Ya puedes iniciar sesión.' });
  } catch (e) { res.status(500).json({ message: 'Error del servidor' }); }
});

// Start password reset: send email with token. The answer is the same whether
// or not the email is registered, and the mail is sent in the background so
// the response time does not tell either.
router.post(
  '/reset-start',
  byIp('reset', 10, 15 * MINUTE),
  byEmail('reset', 3, 15 * MINUTE),
  async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: 'Email requerido' });

    const user = await User.findOne({ where: { email } });
    if (user && user.isActive) {
      const resetToken = uuidv4();
      await user.update({
        resetPasswordToken: hashResetToken(resetToken),
        resetPasswordExpires: new Date(Date.now() + RESET_TOKEN_TTL_MS),
      });
      sendResetPasswordEmail(user.email, user.name, resetToken).catch((mailErr) =>
        console.error('Failed to send reset email:', mailErr),
      );
    }

    res.json({ message: RESET_START_MESSAGE });
  } catch (e) { res.status(500).json({ message: 'Error del servidor' }); }
  },
);

// Complete password reset: update password using token
router.post('/reset-password', byIp('reset-password', 10, 15 * MINUTE), async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ message: 'Token y contraseña requeridos' });
    if (!isAcceptablePassword(password)) return res.status(400).json({ message: 'Weak password' });

    const user = await User.findOne({
      where: {
        resetPasswordToken: hashResetToken(token),
        resetPasswordExpires: { [Op.gt]: new Date() }
      }
    });

    if (!user) return res.status(400).json({ message: 'Token inválido o expirado' });

    const passwordHash = await bcrypt.hash(password, 10);
    await user.update({
      passwordHash,
      resetPasswordToken: null,
      resetPasswordExpires: null,
      // The link reached their inbox, which proves they own the address.
      isEmailVerified: true,
      verificationToken: null,
    });

    res.json({ message: 'Contraseña actualizada correctamente.' });
  } catch (e) { res.status(500).json({ message: 'Error del servidor' }); }
});

export default router;
