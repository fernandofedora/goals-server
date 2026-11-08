import jwt from 'jsonwebtoken';
import { Account, Card, Category, User } from '../src/models/index.js';

let seq = 0;

/** A fresh user per test keeps tests independent without cleaning tables. */
export async function createUser() {
  seq += 1;
  const user = await User.create({
    name: `Test ${seq}`,
    email: `test-${seq}-${Math.random().toString(36).slice(2)}@local.test`,
    passwordHash: 'not-a-real-hash',
  });
  const token = jwt.sign({ id: user.id }, process.env.SECRET_KEY);
  return { user, auth: { Authorization: `Bearer ${token}` } };
}

export const createCategory = (user, name, type = 'expense', extra = {}) =>
  Category.create({ name, type, UserId: user.id, ...extra });

export const createCard = (user, name = 'Visa') =>
  Card.create({ name, last4: '4242', UserId: user.id });

export const createAccount = (user, name = 'Banco', extra = {}) =>
  Account.create({ name, initialBalance: 0, UserId: user.id, ...extra });
