import mysql from 'mysql2/promise';
import { applyTestEnv } from './test-env.js';

export default async function setup() {
  const database = applyTestEnv();

  const conn = await mysql.createConnection({
    host: process.env.MYSQLHOST,
    port: Number(process.env.MYSQLPORT || process.env.DB_PORT || 3306),
    user: process.env.MYSQLUSER || process.env.DB_USER,
    password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD,
  });
  await conn.query(`DROP DATABASE IF EXISTS \`${database}\``);
  await conn.query(`CREATE DATABASE \`${database}\``);
  await conn.end();

  // Dynamic: db.js reads the connection settings at import time.
  const { connectDB, sequelize } = await import('../src/config/db.js');
  await import('../src/models/index.js');
  await connectDB();
  await sequelize.close();
}
