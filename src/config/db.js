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

    const descTrans = await qi.describeTable('Transactions').catch(() => ({}));
    if (!descTrans.AccountId) {
      await qi.addColumn('Transactions', 'AccountId', { type: DataTypes.INTEGER, allowNull: true });
    }

    // Expand Transactions.paymentMethod ENUM to include 'account'
    // We use a raw ALTER TABLE because Sequelize's changeColumn may not
    // always update an existing ENUM safely on MySQL.
    try {
      await sequelize.query(
        "ALTER TABLE `Transactions` MODIFY COLUMN `paymentMethod` ENUM('cash','card','account') NOT NULL"
      );
      console.log('Transactions.paymentMethod ENUM expanded to include account');
    } catch (enumErr) {
      // Already includes 'account' or another harmless error — safe to ignore
      if (!enumErr.message?.includes("can't change column") &&
          !enumErr.message?.includes('already')) {
        console.warn('Could not expand Transactions paymentMethod ENUM:', enumErr.message);
      }
    }

    // Data migration: fix legacy rows that have an AccountId but were saved
    // as paymentMethod='cash' due to the old workaround.
    const [migrationResult] = await sequelize.query(
      "UPDATE `Transactions` SET `paymentMethod` = 'account' WHERE `AccountId` IS NOT NULL AND `paymentMethod` = 'cash'"
    );
    if (migrationResult.affectedRows > 0) {
      console.log(`Migration: updated ${migrationResult.affectedRows} transaction(s) from paymentMethod='cash' → 'account' (had AccountId)`);
    }

    const descSched = await qi.describeTable('ScheduledPayments').catch(() => ({}));
    if (!descSched.paymentMethod) {
      await qi.addColumn('ScheduledPayments', 'paymentMethod', { type: DataTypes.ENUM('card', 'cash', 'account'), allowNull: true });
    }
    if (!descSched.AccountId) {
      await qi.addColumn('ScheduledPayments', 'AccountId', { type: DataTypes.INTEGER, allowNull: true });
    }

    // Add monthlyBudget to Categories if not present
    const descCats = await qi.describeTable('Categories').catch(() => ({}));
    if (!descCats.monthlyBudget) {
      await qi.addColumn('Categories', 'monthlyBudget', { type: DataTypes.DECIMAL(10, 2), allowNull: true, defaultValue: null });
      console.log('Migration: added Categories.monthlyBudget column');
    }
    const desc = await qi.describeTable('Users').catch(() => ({}));
    if (!desc.publicId) {
      await qi.addColumn('Users', 'publicId', { type: DataTypes.UUID, allowNull: true, unique: true });
    }
    if (!desc.lastLoginAt) {
      await qi.addColumn('Users', 'lastLoginAt', { type: DataTypes.DATE, allowNull: true });
    }
    if (!desc.isSuperAdmin) {
      await qi.addColumn('Users', 'isSuperAdmin', { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });
      console.log('Migration: added Users.isSuperAdmin column');
    }
    if (!desc.isActive) {
      await qi.addColumn('Users', 'isActive', { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true });
      console.log('Migration: added Users.isActive column');
    }
    const descCards = await qi.describeTable('Cards').catch(() => ({}));
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
