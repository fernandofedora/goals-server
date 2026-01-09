const store = new Map();

export const rateLimit = (keyFn, { limit = 5, windowMs = 5 * 60 * 1000 } = {}) => {
  return (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    const entry = store.get(key) || { count: 0, reset: now + windowMs };
    if (now > entry.reset) {
      entry.count = 0;
      entry.reset = now + windowMs;
    }
    entry.count += 1;
    store.set(key, entry);
    if (entry.count > limit) {
      return res.status(429).json({ message: 'Too many requests' });
    }
    next();
  };
};

