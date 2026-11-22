import { createHmac, timingSafeEqual } from 'crypto';

// Email lists a user can leave from a link, without signing in.
export const UNSUBSCRIBE_LISTS = {
  monthly: 'monthlySummaryEnabled',
};

const sign = (list, publicId) =>
  createHmac('sha256', process.env.SECRET_KEY || '')
    .update(`unsubscribe:${list}:${publicId}`)
    .digest('base64url')
    .slice(0, 32);

/** Signed link to the client's /unsubscribe page for one list. */
export const unsubscribeUrl = (list, publicId) => {
  const base = (process.env.FRONTEND_URL || '').replace(/\/+$/, '');
  const qs = new URLSearchParams({ list, u: publicId, t: sign(list, publicId) });
  return `${base}/unsubscribe?${qs}`;
};

export const isValidUnsubscribeToken = (list, publicId, token) => {
  if (!UNSUBSCRIBE_LISTS[list] || !publicId || typeof token !== 'string') return false;
  const expected = Buffer.from(sign(list, publicId));
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
};
