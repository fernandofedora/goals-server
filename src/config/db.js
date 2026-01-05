import dotenv from 'dotenv';
import { Sequelize, DataTypes } from 'sequelize';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

export const sequelize = new Sequelize(
  process.env.MYSQLDATABASE || process.env.DB_DATABASE,
  process.env.MYSQLUSER || process.env.DB_USER,
  process.env.MYSQLPASSWORD || process.env.DB_PASSWORD,
  {
    host: process.env.MYSQLHOST || process.env.DB_HOST,
    port: process.env.MYSQLPORT || process.env.DB_PORT,
    dialect: 'mysql',
    logging: false
  }
);

export const connectDB = async () => {
  try {
    await sequelize.authenticate();
    await sequelize.sync();
    const qi = sequelize.getQueryInterface();
    const desc = await qi.describeTable('Users').catch(() => ({}));
    if (!desc.publicId) {
      await qi.addColumn('Users', 'publicId', { type: DataTypes.UUID, allowNull: true, unique: true });
    }
    const [rows] = await sequelize.query('SELECT id FROM `Users` WHERE `publicId` IS NULL');
    for (const r of rows) {
      await sequelize.query('UPDATE `Users` SET `publicId` = :uuid WHERE `id` = :id', { replacements: { uuid: uuidv4(), id: r.id } });
    }
    const updatedDesc = await qi.describeTable('Users').catch(() => ({}));
    if (updatedDesc.publicId && updatedDesc.publicId.allowNull) {
      await qi.changeColumn('Users', 'publicId', { type: DataTypes.UUID, allowNull: false, unique: true });
    }
    console.log('Database connected and synced');
  } catch (err) {
    console.error('DB connection error', err);
  }
};

connectDB();
