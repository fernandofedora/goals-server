/**
 * Amount for emails, e.g. "$2,450.00" or "€2,450.00": the short symbol, comma
 * thousands and dot decimals in both languages, close to how the app shows it.
 */
export const formatMoney = (amount, currency = 'USD') => {
  const value = Number(amount) || 0;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
};
