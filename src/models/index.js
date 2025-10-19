import { DataTypes } from 'sequelize';
import { sequelize } from '../config/db.js';

export const User = sequelize.define('User', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  name: { type: DataTypes.STRING, allowNull: false },
  email: { type: DataTypes.STRING, allowNull: false, unique: true },
  passwordHash: { type: DataTypes.STRING, allowNull: false }
});

export const Category = sequelize.define('Category', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  name: { type: DataTypes.STRING, allowNull: false },
  color: { type: DataTypes.STRING, allowNull: false, defaultValue: '#3b82f6' },
  type: { type: DataTypes.ENUM('expense','income'), allowNull: false }
});

export const Card = sequelize.define('Card', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  name: { type: DataTypes.STRING, allowNull: false },
  color: { type: DataTypes.STRING, allowNull: false, defaultValue: '#0ea5e9' },
  last4: { type: DataTypes.STRING, allowNull: false }
});

export const Transaction = sequelize.define('Transaction', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  type: { type: DataTypes.ENUM('expense','income'), allowNull: false },
  description: { type: DataTypes.STRING, allowNull: false },
  amount: { type: DataTypes.DECIMAL(10,2), allowNull: false },
  date: { type: DataTypes.DATEONLY, allowNull: false },
  paymentMethod: { type: DataTypes.ENUM('cash','card'), allowNull: false }
});

export const Budget = sequelize.define('Budget', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  month: { type: DataTypes.INTEGER, allowNull: false },
  year: { type: DataTypes.INTEGER, allowNull: false },
  amount: { type: DataTypes.DECIMAL(10,2), allowNull: false }
});

// Associations
User.hasMany(Category); Category.belongsTo(User);
User.hasMany(Card); Card.belongsTo(User);
User.hasMany(Transaction); Transaction.belongsTo(User);
Category.hasMany(Transaction); Transaction.belongsTo(Category);
Card.hasMany(Transaction); Transaction.belongsTo(Card);
User.hasMany(Budget); Budget.belongsTo(User);