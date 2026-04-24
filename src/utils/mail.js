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
