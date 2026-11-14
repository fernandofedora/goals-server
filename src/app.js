import express from 'express';
import cors from 'cors';
import authRoutes from './routes/auth.js';
import categoryRoutes from './routes/categories.js';
import cardRoutes from './routes/cards.js';
import transactionRoutes from './routes/transactions.js';
import budgetRoutes from './routes/budgets.js';
import statsRoutes from './routes/stats.js';
import savingsRoutes from './routes/savings.js';
import accountsRoutes from './routes/accounts.js';
import userRoutes from './routes/user.js';
import scheduledPaymentsRoutes from './routes/scheduledPayments.js';
import adminRoutes from './routes/admin.js';
import investmentsRoutes from './routes/investments.js';
import rulesRoutes from './routes/rules.js';
import importRoutes from './routes/import.js';

// Separate from index.js so tests can mount the API without listening or booting the DB.
export const app = express();

app.use(cors());
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/cards', cardRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/budgets', budgetRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/savings', savingsRoutes);
app.use('/api/accounts', accountsRoutes);
app.use('/api/user', userRoutes);
app.use('/api/scheduled-payments', scheduledPaymentsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/investments', investmentsRoutes);
app.use('/api/rules', rulesRoutes);
app.use('/api/import', importRoutes);
