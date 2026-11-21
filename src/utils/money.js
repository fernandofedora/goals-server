/** Amount in the user's currency and language, e.g. "$1,234.50" or "1234,50 US$". */
export const formatMoney = (amount, currency = 'USD', language = 'es') => {
  const value = Number(amount) || 0;
  try {
    return new Intl.NumberFormat(language === 'en' ? 'en-US' : 'es', {
      style: 'currency',
      currency,
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
};
