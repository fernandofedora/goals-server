import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { sequelize } from '../config/db.js';
import {
  InvestmentHolding,
  InvestmentPurchase,
  User,
} from '../models/index.js';
import {
  search,
  getSymbol,
  getQuote,
  getQuotes,
  formatSymbol,
  toAssetType,
} from '../services/marketData/index.js';
import { getRate, getRatesDate } from '../services/fx.js';

// Experimental investments module. Independent by design: it never touches
// Transactions, Accounts, Cards, Categories or stats.
const router = express.Router();
router.use(authMiddleware);

const round = (n, d) =>
  n == null || !Number.isFinite(n) ? null : Number(n.toFixed(d));

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function getUserCurrency(userId) {
  const user = await User.findByPk(userId, { attributes: ['currency'] });
  return user?.currency || 'USD';
}

class InputError extends Error {}

const parsePositive = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : NaN;
};

/**
 * Turns the request body into the stored purchase values.
 * - amount is in the user's currency by default (amountCurrency='user') or in
 *   the asset's currency (amountCurrency='quote').
 * - pricePerShare / shares are optional overrides from the user's broker; when
 *   absent the fallback price is used (current quote, or the old price on edit).
 */
function buildPurchase(body, { fxRate, userCurrency, fallbackPrice }) {
  const amount = parsePositive(body.amount);
  let price = parsePositive(body.pricePerShare);
  let shares = parsePositive(body.shares);
  if ([amount, price, shares].some(Number.isNaN)) {
    throw new InputError(
      'Monto, precio y acciones deben ser números mayores que 0',
    );
  }
  const amountCurrency = body.amountCurrency === 'quote' ? 'quote' : 'user';

  let amountQuote;
  if (amount)
    amountQuote = amountCurrency === 'quote' ? amount : amount / fxRate;
  else if (shares && price) amountQuote = shares * price;
  else throw new InputError('Indica el monto invertido');

  if (!price) price = shares ? amountQuote / shares : fallbackPrice;
  if (!price) {
    throw new InputError(
      'No hay precio disponible para este activo; indica el precio por acción',
    );
  }
  if (!shares) shares = amountQuote / price;

  const amountUser =
    amount && amountCurrency === 'user' ? amount : amountQuote * fxRate;

  const date = body.date || todayStr();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
    throw new InputError('Fecha inválida');
  }
  if (date > todayStr()) throw new InputError('La fecha no puede ser futura');

  return {
    date,
    shares: round(shares, 8),
    pricePerShare: round(price, 6),
    amountQuote: round(amountQuote, 2),
    userCurrency,
    fxRate: round(fxRate, 8),
    amountUser: round(amountUser, 2),
    note: body.note ? String(body.note).slice(0, 255) : null,
  };
}

// FX from the asset's currency to the user's. If the user's currency is unknown
// to the FX source, everything stays in the asset's currency.
async function resolveFx(quoteCurrency, userCurrency) {
  const rate = await getRate(quoteCurrency, userCurrency);
  return rate
    ? { fxRate: rate, currency: userCurrency, fxUnavailable: false }
    : { fxRate: 1, currency: quoteCurrency, fxUnavailable: true };
}

const formatPurchase = (p) => ({
  id: p.id,
  date: p.date,
  shares: Number(p.shares),
  pricePerShare: Number(p.pricePerShare),
  amountQuote: Number(p.amountQuote),
  userCurrency: p.userCurrency,
  fxRate: Number(p.fxRate),
  amountUser: Number(p.amountUser),
  note: p.note,
});

const formatHoldingBase = (h) => ({
  id: h.id,
  symbol: h.symbol,
  providerSymbol: h.providerSymbol,
  name: h.name,
  assetType: h.assetType,
  exchange: h.exchange,
  quoteCurrency: h.quoteCurrency,
  status: h.status,
});

function sendError(res, err) {
  if (err instanceof InputError)
    return res.status(400).json({ message: err.message });
  throw err;
}

async function findOwnedHolding(id, userId) {
  return InvestmentHolding.findOne({ where: { id, UserId: userId } });
}

async function findOwnedPurchase(purchaseId, userId) {
  return InvestmentPurchase.findOne({
    where: { id: purchaseId },
    include: [
      { model: InvestmentHolding, where: { UserId: userId }, required: true },
    ],
  });
}

// --- Search & quote ------------------------------------------------------------

// GET /api/investments/search?q=voo — local catalog, no provider calls
router.get('/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json([]);
  res.json(await search(q));
});

// GET /api/investments/quote/:providerSymbol — price + conversion to user currency
router.get('/quote/:providerSymbol', async (req, res) => {
  const sym = await getSymbol(req.params.providerSymbol);
  if (!sym) return res.status(404).json({ message: 'Símbolo no encontrado' });
  const userCurrency = await getUserCurrency(req.userId);
  const [quote, fx, fxDate] = await Promise.all([
    getQuote(sym.providerSymbol, sym.currency),
    resolveFx(sym.currency, userCurrency),
    getRatesDate(),
  ]);
  res.json({
    ...formatSymbol(sym),
    quote,
    userCurrency,
    displayCurrency: fx.currency,
    fxRate: fx.fxRate,
    fxUnavailable: fx.fxUnavailable,
    fxDate,
    priceUser: quote ? round(quote.price * fx.fxRate, 6) : null,
  });
});

// --- Holdings ----------------------------------------------------------------

// GET /api/investments — active holdings valued in the user's currency + totals
router.get('/', async (req, res) => {
  const userCurrency = await getUserCurrency(req.userId);
  const holdings = await InvestmentHolding.findAll({
    where: { UserId: req.userId, status: 'active' },
    include: [InvestmentPurchase],
    order: [['createdAt', 'ASC']],
  });
  const [quotes, fxDate] = await Promise.all([
    getQuotes(
      holdings.map((h) => ({
        providerSymbol: h.providerSymbol,
        currency: h.quoteCurrency,
      })),
    ),
    getRatesDate(),
  ]);

  const items = [];
  for (const h of holdings) {
    const fx = await resolveFx(h.quoteCurrency, userCurrency);
    const quote = quotes.get(h.providerSymbol) || null;
    const purchases = h.InvestmentPurchases || [];

    const shares = purchases.reduce((s, p) => s + Number(p.shares), 0);
    const costQuote = purchases.reduce((s, p) => s + Number(p.amountQuote), 0);
    // Purchases recorded in the user's current currency keep their historical
    // FX; older ones (user changed currency since) are converted at today's rate.
    const costUser = purchases.reduce(
      (s, p) =>
        s +
        (p.userCurrency === fx.currency
          ? Number(p.amountUser)
          : Number(p.amountQuote) * fx.fxRate),
      0,
    );
    const valueQuote = quote ? shares * quote.price : null;
    const valueUser = valueQuote != null ? valueQuote * fx.fxRate : null;
    const gainUser = valueUser != null ? valueUser - costUser : null;

    items.push({
      ...formatHoldingBase(h),
      displayCurrency: fx.currency,
      fxRate: fx.fxRate,
      fxUnavailable: fx.fxUnavailable,
      purchasesCount: purchases.length,
      shares: round(shares, 8),
      avgPrice: shares > 0 ? round(costQuote / shares, 6) : null,
      costQuote: round(costQuote, 2),
      costUser: round(costUser, 2),
      price: quote?.price ?? null,
      previousClose: quote?.previousClose ?? null,
      changePercent: quote?.changePercent ?? null,
      valueQuote: round(valueQuote, 2),
      valueUser: round(valueUser, 2),
      gainUser: round(gainUser, 2),
      gainPercent:
        gainUser != null && costUser > 0
          ? round((gainUser / costUser) * 100, 2)
          : null,
      dayChangeUser:
        quote?.change != null
          ? round(quote.change * shares * fx.fxRate, 2)
          : null,
      quotedAt: quote?.quotedAt ?? null,
      stale: quote ? quote.stale : null,
      priceUnavailable: !quote,
    });
  }

  // Totals only add up holdings expressed in the user's currency with a price.
  const counted = items.filter((i) => !i.fxUnavailable && i.valueUser != null);
  const totalValue = counted.reduce((s, i) => s + i.valueUser, 0);
  const totalCost = counted.reduce((s, i) => s + i.costUser, 0);
  const dayChange = counted.reduce((s, i) => s + (i.dayChangeUser || 0), 0);
  for (const i of items) {
    i.weight =
      counted.includes(i) && totalValue > 0
        ? round((i.valueUser / totalValue) * 100, 2)
        : null;
  }
  const quotedTimes = items
    .map((i) => i.quotedAt)
    .filter(Boolean)
    .map((d) => new Date(d).getTime());

  res.json({
    currency: userCurrency,
    fxDate,
    quotedAt: quotedTimes.length ? new Date(Math.max(...quotedTimes)) : null,
    stale: items.some((i) => i.stale),
    totals: {
      value: round(totalValue, 2),
      cost: round(totalCost, 2),
      gain: round(totalValue - totalCost, 2),
      gainPercent:
        totalCost > 0
          ? round(((totalValue - totalCost) / totalCost) * 100, 2)
          : null,
      dayChange: round(dayChange, 2),
      dayChangePercent:
        totalValue - dayChange > 0
          ? round((dayChange / (totalValue - dayChange)) * 100, 2)
          : null,
    },
    holdings: items,
  });
});

// POST /api/investments — create (or reuse) a holding and record its purchase
router.post('/', async (req, res) => {
  const { providerSymbol } = req.body;
  if (!providerSymbol)
    return res.status(400).json({ message: 'Selecciona una acción o ETF' });
  // Name, exchange, type and currency always come from the catalog, never the client.
  const sym = await getSymbol(String(providerSymbol));
  if (!sym) return res.status(404).json({ message: 'Símbolo no encontrado' });
  if (!sym.currency)
    return res
      .status(422)
      .json({ message: 'Este activo no tiene moneda de cotización' });

  const userCurrency = await getUserCurrency(req.userId);
  const [fx, quote] = await Promise.all([
    resolveFx(sym.currency, userCurrency),
    getQuote(sym.providerSymbol, sym.currency),
  ]);

  let values;
  try {
    values = buildPurchase(req.body, {
      fxRate: fx.fxRate,
      userCurrency: fx.currency,
      fallbackPrice: quote?.price,
    });
  } catch (err) {
    return sendError(res, err);
  }

  const result = await sequelize.transaction(async (t) => {
    const [holding] = await InvestmentHolding.findOrCreate({
      where: { UserId: req.userId, providerSymbol: sym.providerSymbol },
      defaults: {
        symbol: sym.symbol,
        exchange: sym.mic,
        name: sym.name,
        assetType: toAssetType(sym.type),
        quoteCurrency: sym.currency,
      },
      transaction: t,
    });
    if (holding.status !== 'active')
      await holding.update({ status: 'active' }, { transaction: t });
    const purchase = await InvestmentPurchase.create(
      { ...values, InvestmentHoldingId: holding.id },
      { transaction: t },
    );
    return { holding, purchase };
  });

  res.status(201).json({
    holding: formatHoldingBase(result.holding),
    purchase: formatPurchase(result.purchase),
  });
});

// GET /api/investments/:id/purchases — purchase history of a holding
router.get('/:id/purchases', async (req, res) => {
  const holding = await findOwnedHolding(req.params.id, req.userId);
  if (!holding)
    return res.status(404).json({ message: 'Inversión no encontrada' });
  const purchases = await InvestmentPurchase.findAll({
    where: { InvestmentHoldingId: holding.id },
    order: [
      ['date', 'DESC'],
      ['id', 'DESC'],
    ],
  });
  res.json({
    holding: formatHoldingBase(holding),
    purchases: purchases.map(formatPurchase),
  });
});

// POST /api/investments/:id/purchases — "I bought more"
router.post('/:id/purchases', async (req, res) => {
  const holding = await findOwnedHolding(req.params.id, req.userId);
  if (!holding)
    return res.status(404).json({ message: 'Inversión no encontrada' });

  const userCurrency = await getUserCurrency(req.userId);
  const [fx, quote] = await Promise.all([
    resolveFx(holding.quoteCurrency, userCurrency),
    getQuote(holding.providerSymbol, holding.quoteCurrency),
  ]);
  let values;
  try {
    values = buildPurchase(req.body, {
      fxRate: fx.fxRate,
      userCurrency: fx.currency,
      fallbackPrice: quote?.price,
    });
  } catch (err) {
    return sendError(res, err);
  }

  const purchase = await InvestmentPurchase.create({
    ...values,
    InvestmentHoldingId: holding.id,
  });
  if (holding.status !== 'active') await holding.update({ status: 'active' });
  res.status(201).json(formatPurchase(purchase));
});

// PUT /api/investments/purchases/:purchaseId — fix a purchase. Keeps the FX rate
// and currency it was recorded with, and its old price unless a new one is sent.
router.put('/purchases/:purchaseId', async (req, res) => {
  const purchase = await findOwnedPurchase(req.params.purchaseId, req.userId);
  if (!purchase)
    return res.status(404).json({ message: 'Compra no encontrada' });
  // Partial edits keep the original amount (in the asset's currency) unless the
  // body redefines it, directly or through shares + price.
  const body = { date: purchase.date, note: purchase.note, ...req.body };
  if (body.amount === undefined && !(body.shares && body.pricePerShare)) {
    body.amount = Number(purchase.amountQuote);
    body.amountCurrency = 'quote';
  }
  let values;
  try {
    values = buildPurchase(body, {
      fxRate: Number(purchase.fxRate),
      userCurrency: purchase.userCurrency,
      fallbackPrice: Number(purchase.pricePerShare),
    });
  } catch (err) {
    return sendError(res, err);
  }
  await purchase.update(values);
  res.json(formatPurchase(purchase));
});

// DELETE /api/investments/purchases/:purchaseId
router.delete('/purchases/:purchaseId', async (req, res) => {
  const purchase = await findOwnedPurchase(req.params.purchaseId, req.userId);
  if (!purchase)
    return res.status(404).json({ message: 'Compra no encontrada' });
  await purchase.destroy();
  res.status(204).send();
});

// DELETE /api/investments/:id — remove a holding and all its purchases
router.delete('/:id', async (req, res) => {
  const holding = await findOwnedHolding(req.params.id, req.userId);
  if (!holding)
    return res.status(404).json({ message: 'Inversión no encontrada' });
  await sequelize.transaction(async (t) => {
    await InvestmentPurchase.destroy({
      where: { InvestmentHoldingId: holding.id },
      transaction: t,
    });
    await holding.destroy({ transaction: t });
  });
  res.status(204).send();
});

export default router;
