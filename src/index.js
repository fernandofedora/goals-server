import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { connectDB } from './config/db.js';
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
import { processScheduledPayments } from './cron.js';

dotenv.config();
const app = express();

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

const PORT = process.env.PORT || 4000;

// Start listening IMMEDIATELY. Hostinger/LiteSpeed (Passenger) marks the app as
// 503 if app.listen() is delayed behind the DB handshake + migrations, so the
// HTTP server must come up first and DB init must NOT block module startup
// (a top-level `await connectDB()` here is what caused the production 503).
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// Initialize the DB (authenticate + sync + migrations) and then run the
// scheduled-payments catch-up, in the background. Ordering is preserved
// (connectDB resolves before the catch-up) without blocking the listener.
(async () => {
  try {
    await connectDB();
    await processScheduledPayments();
  } catch (err) {
    console.error('Startup initialization error:', err);
  }
})();
