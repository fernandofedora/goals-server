import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import './config/db.js';
import authRoutes from './routes/auth.js';
import categoryRoutes from './routes/categories.js';
import cardRoutes from './routes/cards.js';
import transactionRoutes from './routes/transactions.js';
import budgetRoutes from './routes/budgets.js';
import statsRoutes from './routes/stats.js';

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

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));