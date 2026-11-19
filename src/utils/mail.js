import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: parseInt(process.env.EMAIL_PORT),
  secure: process.env.EMAIL_SECURE === 'true',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

export const sendVerificationEmail = async (email, name, token) => {
  const url = `${process.env.FRONTEND_URL}/verify-email/${token}`;
  const mailOptions = {
    from: `"Goals App" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: 'Verifica tu cuenta - Goals App',
    html: `
      <h2>Hola ${name}!</h2>
      <p>Bienvenido a Goals App. Por favor, haz clic en el siguiente enlace para verificar tu cuenta:</p>
      <a href="${url}" style="display: inline-block; padding: 10px 20px; background-color: #4f46e5; color: white; text-decoration: none; rounded: 5px;">Verificar cuenta</a>
      <p>Si no puedes hacer clic, copia y pega este enlace en tu navegador:</p>
      <p>${url}</p>
    `,
  };

  return transporter.sendMail(mailOptions);
};

export const sendResetPasswordEmail = async (email, name, token) => {
  const url = `${process.env.FRONTEND_URL}/reset-password?token=${token}`;
  const mailOptions = {
    from: `"Goals App" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: 'Restablecer contraseña - Goals App',
    html: `
      <h2>Hola ${name}</h2>
      <p>Has solicitado restablecer tu contraseña. Haz clic en el enlace a continuación para continuar:</p>
      <a href="${url}" style="display: inline-block; padding: 10px 20px; background-color: #059669; color: white; text-decoration: none; rounded: 5px;">Restablecer contraseña</a>
      <p>Este enlace expirará en 1 hora.</p>
      <p>Si no solicitaste esto, puedes ignorar este correo.</p>
    `,
  };

  return transporter.sendMail(mailOptions);
};

const escapeHtml = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

const BUDGET_ALERT_COPY = {
  es: {
    subject80: (cat) => `Ya usaste el 80% del presupuesto de ${cat}`,
    subject100: (cat) => `Llegaste al límite del presupuesto de ${cat}`,
    greeting: (name) => `Hola ${name}:`,
    body: (cat, spent, budget, pct) =>
      `Este mes llevas <strong>${spent}</strong> de <strong>${budget}</strong> en ${cat} (${pct}%).`,
    hint80: 'Todavía te queda margen, pero conviene revisar los próximos gastos.',
    hint100: 'Los gastos que sumes en esta categoría ya quedan por encima de lo planeado.',
    cta: 'Ver mi presupuesto',
    footer: 'Puedes desactivar estos avisos en tu perfil de Goals App.',
  },
  en: {
    subject80: (cat) => `You've used 80% of your ${cat} budget`,
    subject100: (cat) => `You've reached your ${cat} budget`,
    greeting: (name) => `Hi ${name},`,
    body: (cat, spent, budget, pct) =>
      `This month you've spent <strong>${spent}</strong> of <strong>${budget}</strong> on ${cat} (${pct}%).`,
    hint80: "There's still some room, but it's worth keeping an eye on upcoming expenses.",
    hint100: 'Anything else you add to this category goes over what you planned.',
    cta: 'See my budget',
    footer: 'You can turn these alerts off in your Goals App profile.',
  },
};

export const sendBudgetAlertEmail = async ({
  email,
  name,
  language,
  categoryName,
  threshold,
  spent,
  budget,
  percent,
}) => {
  const copy = BUDGET_ALERT_COPY[language] || BUDGET_ALERT_COPY.es;
  const cat = escapeHtml(categoryName);
  const url = `${process.env.FRONTEND_URL}/transactions/budget`;
  const reached = threshold >= 100;
  const mailOptions = {
    from: `"Goals App" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: reached ? copy.subject100(categoryName) : copy.subject80(categoryName),
    html: `
      <p>${copy.greeting(escapeHtml(name))}</p>
      <p>${copy.body(cat, spent, budget, percent)}</p>
      <p>${reached ? copy.hint100 : copy.hint80}</p>
      <a href="${url}" style="display: inline-block; padding: 10px 20px; background-color: #059669; color: white; text-decoration: none; border-radius: 6px;">${copy.cta}</a>
      <p style="color: #4b5563; font-size: 12px; margin-top: 24px;">${copy.footer}</p>
    `,
  };

  return transporter.sendMail(mailOptions);
};
