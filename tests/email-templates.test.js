import { beforeEach, describe, expect, it } from 'vitest';
import {
  budgetAlertEmail,
  resetPasswordEmail,
  verificationEmail,
} from '../src/utils/emailTemplates.js';

beforeEach(() => {
  process.env.FRONTEND_URL = 'https://goals.example/';
});

describe('email templates', () => {
  it('escapes the user name in HTML and keeps it as is in plain text', () => {
    const mail = resetPasswordEmail({ name: '<b>Ana</b>', token: 't', language: 'es' });
    expect(mail.html).not.toContain('<b>Ana</b>');
    expect(mail.html).toContain('&lt;b&gt;Ana&lt;/b&gt;');
    expect(mail.text).toContain('Hola, <b>Ana</b>');
  });

  it('writes in the user language and falls back to Spanish', () => {
    expect(resetPasswordEmail({ name: 'A', token: 't', language: 'en' }).subject).toBe(
      'Reset your Goals password',
    );
    expect(resetPasswordEmail({ name: 'A', token: 't', language: 'fr' }).subject).toBe(
      'Restablece tu contraseña de Goals',
    );
  });

  it('links to the app without a double slash and encodes the token', () => {
    const mail = resetPasswordEmail({ name: 'A', token: 'a b&c', language: 'es' });
    expect(mail.html).toContain('https://goals.example/reset-password?token=a%20b%26c');
    expect(mail.text).toContain('https://goals.example/reset-password?token=a%20b%26c');
    expect(mail.html).not.toContain('example//');
  });

  it('puts the Goals header and the plain-text version in every message', () => {
    const mails = [
      verificationEmail({ name: 'A', token: 't', language: 'es' }),
      resetPasswordEmail({ name: 'A', token: 't', language: 'en' }),
      budgetAlertEmail({
        name: 'A',
        language: 'es',
        categoryName: 'Comida',
        threshold: 80,
        spent: '$80',
        budget: '$100',
        percent: 80,
      }),
    ];
    for (const mail of mails) {
      expect(mail.html).toMatch(/>Goals<\/td>/);
      expect(mail.text.length).toBeGreaterThan(20);
      expect(mail.text).not.toMatch(/<[a-z]/i);
    }
  });

  it('escapes the category name in budget alerts', () => {
    const mail = budgetAlertEmail({
      name: 'A',
      language: 'en',
      categoryName: '<img src=x>',
      threshold: 100,
      spent: '$100',
      budget: '$100',
      percent: 100,
    });
    expect(mail.subject).toBe("You've reached your <img src=x> budget");
    expect(mail.html).not.toContain('<img src=x>');
  });
});
