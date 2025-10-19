import dotenv from 'dotenv';
import { Sequelize } from 'sequelize';

dotenv.config();

export const sequelize = new Sequelize(process.env.DB_DATABASE, process.env.DB_USER, process.env.DB_PASSWORD, {
  host: process.env.DB_HOST,
  dialect: 'mysql',
  logging: false
});

export const connectDB = async () => {
  try {
    await sequelize.authenticate();
    await sequelize.sync();
    console.log('Database connected and synced');
  } catch (err) {
    console.error('DB connection error', err);
  }
};

connectDB();