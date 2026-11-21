import nodemailer from 'nodemailer';
import { budgetAlertEmail, resetPasswordEmail, verificationEmail } from './emailTemplates.js';

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: parseInt(process.env.EMAIL_PORT),
  secure: process.env.EMAIL_SECURE === 'true',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

const send = (to, { subject, html, text }) =>
  transporter.sendMail({
    from: `"Goals App" <${process.env.EMAIL_USER}>`,
    to,
    subject,
    html,
    text,
  });

export const sendVerificationEmail = (email, name, token, language) =>
  send(email, verificationEmail({ name, token, language }));

export const sendResetPasswordEmail = (email, name, token, language) =>
  send(email, resetPasswordEmail({ name, token, language }));

export const sendBudgetAlertEmail = ({ email, ...fields }) =>
  send(email, budgetAlertEmail(fields));
