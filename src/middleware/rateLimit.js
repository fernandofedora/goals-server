const store = new Map();

// Login and reset are keyed by IP and email, so anyone can add keys; drop the
// expired ones now and then so the map does not grow forever.
const SWEEP_EVERY_MS = 60 * 1000;
let lastSweep = Date.now();

const sweep = (now) => {
  if (now - lastSweep < SWEEP_EVERY_MS) return;
  lastSweep = now;
  for (const [key, entry] of store) {
    if (now > entry.reset) store.delete(key);
  }
};

export const rateLimit = (keyFn, { limit = 5, windowMs = 5 * 60 * 1000 } = {}) => {
  return (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    sweep(now);
    const entry = store.get(key) || { count: 0, reset: now + windowMs };
    if (now > entry.reset) {
      entry.count = 0;
      entry.reset = now + windowMs;
    }
    entry.count += 1;
    store.set(key, entry);
    if (entry.count > limit) {
      res.set('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
      return res.status(429).json({ message: 'Too many requests' });
    }
    next();
  };
};

/** Lower-cased, trimmed email from the body, for per-account limits. */
export const bodyEmail = (req) =>
  String(req.body?.email || '').trim().toLowerCase();

/** Tests share one process: start each file with empty counters. */
export const resetRateLimits = () => store.clear();
