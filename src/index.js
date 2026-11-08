import dotenv from 'dotenv';
import { app } from './app.js';
import { connectDB } from './config/db.js';
import { processScheduledPayments } from './cron.js';
import { ensureCatalog } from './services/marketData/index.js';

dotenv.config();

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
  // Investments: first boot on a fresh DB has no symbol catalog yet. Runs after
  // the scheduled payments catch-up and never blocks or fails startup.
  if (process.env.FINNHUB_API_KEY) {
    try {
      await ensureCatalog();
    } catch (err) {
      console.error('Market catalog init failed:', err.message);
    }
  } else {
    console.warn('FINNHUB_API_KEY not set: investments search/quotes disabled');
  }
})();
