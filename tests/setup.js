import { afterAll, vi } from 'vitest';
import { applyTestEnv } from './test-env.js';

applyTestEnv();

// cron.js registers its timers on import.
vi.mock('node-cron', () => ({ default: { schedule: vi.fn() } }));

// .env holds real SMTP credentials: no test may send mail.
vi.mock('../src/utils/mail.js', () => ({
  sendVerificationEmail: vi.fn(async () => {}),
  sendResetPasswordEmail: vi.fn(async () => {}),
  sendBudgetAlertEmail: vi.fn(async () => {}),
}));

afterAll(async () => {
  const { sequelize } = await import('../src/config/db.js');
  await sequelize.close();
});
