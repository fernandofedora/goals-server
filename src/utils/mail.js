import nodemailer from 'nodemailer';
import {
  budgetAlertEmail,
  monthlySummaryEmail,
  resetPasswordEmail,
  verificationEmail,
} from './emailTemplates.js';
import { unsubscribeUrl } from './unsubscribe.js';

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: parseInt(process.env.EMAIL_PORT),
  secure: process.env.EMAIL_SECURE === 'true',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

const send = (to, { subject, html, text }, headers) =>
  transporter.sendMail({
    from: `"Goals App" <${process.env.EMAIL_USER}>`,
    to,
    subject,
    html,
    text,
    headers,
  });

export const sendVerificationEmail = (email, name, token, language) =>
  send(email, verificationEmail({ name, token, language }));

export const sendResetPasswordEmail = (email, name, token, language) =>
  send(email, resetPasswordEmail({ name, token, language }));

export const sendBudgetAlertEmail = ({ email, ...fields }) =>
  send(email, budgetAlertEmail(fields));

export const sendMonthlySummaryEmail = ({ user, month, summary }) => {
  const unsubscribe = unsubscribeUrl('monthly', user.publicId);
  return send(
    user.email,
    monthlySummaryEmail({
      name: user.name,
      language: user.language,
      currency: user.currency,
      month,
      summary,
      unsubscribeUrl: unsubscribe,
    }),
    // Lets Gmail and others show their own "unsubscribe" button.
    { 'List-Unsubscribe': `<${unsubscribe}>` },
  );
};
