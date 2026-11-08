import dotenv from 'dotenv';

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1'];

// .env can hold production credentials and global-setup drops this schema,
// so anything but a local *_test database is refused.
export function applyTestEnv() {
  dotenv.config({ quiet: true });

  const database = process.env.TEST_DB_DATABASE || 'pg_system_test';
  const host =
    process.env.TEST_DB_HOST || process.env.MYSQLHOST || process.env.DB_HOST;

  if (!database.endsWith('_test')) {
    throw new Error(
      `Refusing to run tests: "${database}" does not end in _test`,
    );
  }
  if (!LOCAL_HOSTS.includes(host)) {
    throw new Error(`Refusing to run tests: DB host "${host}" is not local`);
  }

  process.env.MYSQLDATABASE = database;
  process.env.MYSQLHOST = host;
  process.env.SECRET_KEY = 'test-secret';
  return database;
}
