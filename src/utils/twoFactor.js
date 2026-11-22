import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

// The TOTP secret is stored encrypted with its own key, apart from SECRET_KEY:
// rotating the JWT key must not lock anyone out of their account.
const keyFromEnv = () => {
  const raw = process.env.TWO_FACTOR_KEY || '';
  return raw.length >= 32 ? createHash('sha256').update(raw).digest() : null;
};

export const isTwoFactorConfigured = () => keyFromEnv() !== null;

/** "iv.tag.ciphertext", base64url, AES-256-GCM. */
export function encryptSecret(plain) {
  const key = keyFromEnv();
  if (!key) throw new Error('TWO_FACTOR_KEY is not set');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}

export function decryptSecret(stored) {
  const key = keyFromEnv();
  if (!key) throw new Error('TWO_FACTOR_KEY is not set');
  const [iv, tag, data] = String(stored).split('.').map((p) => Buffer.from(p, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

// Recovery codes: shown once, stored only as hashes, each works one time.
const RECOVERY_COUNT = 10;
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const normalizeRecovery = (code) => String(code ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const hashRecovery = (code) => createHash('sha256').update(normalizeRecovery(code)).digest('hex');

export function generateRecoveryCodes() {
  const codes = [];
  for (let i = 0; i < RECOVERY_COUNT; i += 1) {
    const bytes = randomBytes(8);
    const chars = [...bytes].map((b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join('');
    codes.push(`${chars.slice(0, 4)}-${chars.slice(4)}`);
  }
  return { codes, stored: JSON.stringify(codes.map(hashRecovery)) };
}

/** The stored list without `code`, or null when `code` isn't one of them. */
export function consumeRecoveryCode(stored, code) {
  if (normalizeRecovery(code).length !== 8) return null;
  let hashes;
  try {
    hashes = JSON.parse(stored || '[]');
  } catch {
    return null;
  }
  const h = hashRecovery(code);
  if (!hashes.includes(h)) return null;
  return JSON.stringify(hashes.filter((x) => x !== h));
}

export const remainingRecoveryCodes = (stored) => {
  try {
    return JSON.parse(stored || '[]').length;
  } catch {
    return 0;
  }
};

// Short-lived token between the password step and the code step. Purpose is
// checked on both sides: authMiddleware refuses it as a session token.
export const TWO_FACTOR_PURPOSE = '2fa-login';
export const TWO_FACTOR_TTL = '5m';
