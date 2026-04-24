import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { User, Category } from '../models/index.js';
import { sendVerificationEmail, sendResetPasswordEmail } from '../utils/mail.js';

const router = express.Router();

router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    const existing = await User.findOne({ where: { email } });
    if (existing) return res.status(400).json({ message: 'El correo electrónico ya está registrado' });
    
    const passwordHash = await bcrypt.hash(password, 10);
    const verificationToken = uuidv4();
    
    const user = await User.create({ 
      name, 
      email, 
      passwordHash,
      isEmailVerified: false,
      verificationToken
    });

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

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ where: { email } });
    if (!user) return res.status(400).json({ message: 'Credenciales inválidas' });
    if (!user.isActive) return res.status(403).json({ message: 'Cuenta desactivada. Contacta a un administrador.' });
    if (!user.isEmailVerified) return res.status(403).json({ message: 'Por favor verifica tu correo electrónico para iniciar sesión.' });
    
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(400).json({ message: 'Credenciales inválidas' });
    
    const token = jwt.sign({ id: user.id, isSuperAdmin: user.isSuperAdmin }, process.env.SECRET_KEY, { expiresIn: '7d' });
    const now = new Date();
    await user.update({ lastLoginAt: now });
    res.json({ token, user: { publicId: user.publicId, name: user.name, email: user.email, createdAt: user.createdAt, lastLoginAt: now, isSuperAdmin: user.isSuperAdmin } });
  } catch (e) { res.status(500).json({ message: 'Error del servidor' }); }
});

router.get('/verify-email/:token', async (req, res) => {
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

// Start password reset: send email with token
router.post('/reset-start', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: 'Email requerido' });
    
    const user = await User.findOne({ where: { email } });
    if (!user) {
      // For security, don't reveal if user exists, but we can if the business requires it.
      // Usually better to return success anyway.
      return res.json({ message: 'Si el correo existe, se enviará un enlace de recuperación.' });
    }

    const resetToken = uuidv4();
    const expires = new Date(Date.now() + 3600000); // 1 hour

    await user.update({ 
      resetPasswordToken: resetToken, 
      resetPasswordExpires: expires 
    });

    try {
      await sendResetPasswordEmail(user.email, user.name, resetToken);
    } catch (mailErr) {
      console.error('Failed to send reset email:', mailErr);
    }

    res.json({ message: 'Se ha enviado un enlace de recuperación a tu correo.' });
  } catch (e) { res.status(500).json({ message: 'Error del servidor' }); }
});

// Complete password reset: update password using token
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ message: 'Token y contraseña requeridos' });
    
    const { Op } = (await import('sequelize')).default;
    const user = await User.findOne({ 
      where: { 
        resetPasswordToken: token,
        resetPasswordExpires: { [Op.gt]: new Date() }
      } 
    });

    if (!user) return res.status(400).json({ message: 'Token inválido o expirado' });
    
    const passwordHash = await bcrypt.hash(password, 10);
    await user.update({ 
      passwordHash,
      resetPasswordToken: null,
      resetPasswordExpires: null
    });

    res.json({ message: 'Contraseña actualizada correctamente.' });
  } catch (e) { res.status(500).json({ message: 'Error del servidor' }); }
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
