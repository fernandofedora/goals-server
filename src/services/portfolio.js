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

/**
 * Cost of a holding in the user's currency. Purchases recorded in the user's
 * current currency keep their historical FX; older ones (the user changed
 * currency since) are converted at today's rate.
 */
export const costInUserCurrency = (purchases, fx) =>
  purchases.reduce(
    (s, p) =>
      s +
      (p.userCurrency === fx.currency
        ? Number(p.amountUser)
        : Number(p.amountQuote) * fx.fxRate),
    0,
  );

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
        total += costInUserCurrency(h.InvestmentPurchases || [], fx);
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
    const shares = (h.InvestmentPurchases || []).reduce(
      (s, p) => s + Number(p.shares),
      0,
    );
    total += shares * quote.price * fx.fxRate;
  }
  return Math.round(total * 100) / 100;
}
