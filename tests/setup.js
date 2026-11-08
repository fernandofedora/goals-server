import { afterAll, vi } from 'vitest';
import { applyTestEnv } from './test-env.js';

applyTestEnv();

// cron.js registers its timers on import.
vi.mock('node-cron', () => ({ default: { schedule: vi.fn() } }));

afterAll(async () => {
  const { sequelize } = await import('../src/config/db.js');
  await sequelize.close();
});
