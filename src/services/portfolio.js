import { Op } from 'sequelize';
import { InvestmentHolding, InvestmentPurchase } from '../models/index.js';
import { getQuotes } from './marketData/index.js';
import { getRate } from './fx.js';

/** Rate to show an asset in the user's currency, or its own when unknown. */
export async function resolveFx(quoteCurrency, userCurrency) {
  const rate = await getRate(quoteCurrency, userCurrency);
  return rate
    ? { fxRate: rate, currency: userCurrency, fxUnavailable: false }
    : { fxRate: 1, currency: quoteCurrency, fxUnavailable: true };
}

// Shares below this count as zero (sells are stored with 8 decimals).
const EPSILON = 1e-8;
// Same day: buys first, then dividends, then sells, so selling what was
// bought that morning works whatever order the rows were typed in.
const TYPE_ORDER = { buy: 0, dividend: 1, sell: 2 };

/** Movements in the order they happened. */
export const sortMovements = (movements) =>
  [...movements].sort(
    (a, b) =>
      String(a.date).localeCompare(String(b.date)) ||
      (TYPE_ORDER[a.type || 'buy'] ?? 0) - (TYPE_ORDER[b.type || 'buy'] ?? 0) ||
      (a.id ?? Infinity) - (b.id ?? Infinity),
  );

/**
 * A movement's amount in the user's currency. Rows recorded in the user's
 * current currency keep their historical FX; older ones (the user changed
 * currency since) are converted at today's rate.
 */
const userAmount = (m, fx) =>
  m.userCurrency === fx.currency
    ? Number(m.amountUser)
    : Number(m.amountQuote) * fx.fxRate;

/**
 * Position of one holding after its buys, sells and dividends, with average
 * cost: a sale takes out its share of the cost, and what it brought in above
 * that cost is realized gain. `invalid` is the first sale of more shares than
 * were held at that date (the totals stop there).
 */
export function holdingPosition(movements, fx = { currency: null, fxRate: 1 }) {
  const pos = {
    shares: 0,
    costQuote: 0,
    costUser: 0,
    realizedUser: 0,
    dividendsUser: 0,
    invalid: null,
  };
  for (const m of sortMovements(movements)) {
    const type = m.type || 'buy';
    const shares = Number(m.shares);
    if (type === 'buy') {
      pos.shares += shares;
      pos.costQuote += Number(m.amountQuote);
      pos.costUser += userAmount(m, fx);
    } else if (type === 'dividend') {
      pos.dividendsUser += userAmount(m, fx);
    } else {
      if (shares > pos.shares + EPSILON) {
        pos.invalid = m;
        break;
      }
      const ratio = pos.shares > 0 ? Math.min(1, shares / pos.shares) : 1;
      const costOutUser = pos.costUser * ratio;
      pos.realizedUser += userAmount(m, fx) - costOutUser;
      pos.costQuote -= pos.costQuote * ratio;
      pos.costUser -= costOutUser;
      pos.shares -= shares;
      if (pos.shares < EPSILON) {
        pos.shares = 0;
        pos.costQuote = 0;
        pos.costUser = 0;
      }
    }
  }
  return pos;
}

/**
 * Splits an open gain (value − cost, in the user's currency) into what the
 * price did and what the exchange rate did:
 *   price: (value − cost) in the quote currency, at today's rate
 *   fx:    the cost basis at today's rate − what it cost at the rates paid
 * The two always add up to the gain. Null without a price.
 */
export function gainSplit({ valueQuote, costQuote, costUser, fxRate }) {
  if (valueQuote == null) return null;
  return {
    price: (valueQuote - costQuote) * fxRate,
    fx: costQuote * fxRate - costUser,
  };
}

/**
 * Portfolio value in the user's currency, counted like the investments page
 * total: only holdings with a price and a known exchange rate.
 * With `atDate` (a past month end) it is the cost of what had been bought by
 * then, since no price history is kept.
 */
export async function portfolioValue(userId, userCurrency, atDate = null) {
  const holdings = await InvestmentHolding.findAll({
    where: { UserId: userId, ...(atDate ? {} : { status: 'active' }) },
    include: [
      {
        model: InvestmentPurchase,
        ...(atDate ? { where: { date: { [Op.lte]: atDate } } } : {}),
      },
    ],
  });
  if (!holdings.length) return 0;

  if (atDate) {
    let total = 0;
    for (const h of holdings) {
      const fx = await resolveFx(h.quoteCurrency, userCurrency);
      if (!fx.fxUnavailable)
        total += holdingPosition(h.InvestmentPurchases || [], fx).costUser;
    }
    return Math.round(total * 100) / 100;
  }

  const quotes = await getQuotes(
    holdings.map((h) => ({
      providerSymbol: h.providerSymbol,
      currency: h.quoteCurrency,
    })),
  );
  let total = 0;
  for (const h of holdings) {
    const quote = quotes.get(h.providerSymbol);
    const fx = await resolveFx(h.quoteCurrency, userCurrency);
    if (!quote || fx.fxUnavailable) continue;
    const { shares } = holdingPosition(h.InvestmentPurchases || [], fx);
    total += shares * quote.price * fx.fxRate;
  }
  return Math.round(total * 100) / 100;
}
