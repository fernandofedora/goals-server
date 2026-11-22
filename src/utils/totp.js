import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

// TOTP (RFC 6238) with the defaults every authenticator app uses:
// HMAC-SHA1, 6 digits, 30-second steps.
const STEP_SECONDS = 30;
const DIGITS = 6;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const base32Encode = (buf) => {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
};

export const base32Decode = (str) => {
  const clean = String(str).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
};

/** New random secret, base32 (what the user types if they can't scan). */
export const generateSecret = () => base32Encode(randomBytes(20));

export const stepAt = (ms = Date.now()) => Math.floor(ms / 1000 / STEP_SECONDS);

/** Code for one time step; `key` is the raw secret bytes. */
export function hotp(key, step, digits = DIGITS, algorithm = 'sha1') {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac(algorithm, key).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(bin).padStart(digits, '0');
}

/**
 * Step of the code if it matches now or one step either side (clock drift),
 * else null. Steps at or before `lastStep` are refused so a code that was
 * already used (or seen over someone's shoulder) can't be replayed.
 */
export function verifyTotp(secret, code, { now = Date.now(), window = 1, lastStep = null } = {}) {
  const clean = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return null;
  const key = base32Decode(secret);
  const current = stepAt(now);
  for (let s = current - window; s <= current + window; s += 1) {
    if (lastStep !== null && s <= lastStep) continue;
    const expected = Buffer.from(hotp(key, s));
    if (timingSafeEqual(expected, Buffer.from(clean))) return s;
  }
  return null;
}

export const otpauthUrl = ({ secret, account, issuer = 'Goals' }) => {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const qs = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${qs}`;
};
