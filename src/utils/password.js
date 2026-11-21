import { createHash } from 'crypto';

// bcrypt ignores everything after 72 bytes, so a longer password would only
// look stronger than it is.
const MIN_LENGTH = 8;
const MAX_BYTES = 72;

/** Minimum rule for register and reset; the client asks for the same. */
export const isAcceptablePassword = (password) =>
  typeof password === 'string' &&
  password.length >= MIN_LENGTH &&
  Buffer.byteLength(password, 'utf8') <= MAX_BYTES;

/** Stricter rule used by "change password" in the profile. */
export const isStrongPassword = (password) =>
  isAcceptablePassword(password) &&
  /[a-z]/.test(password) &&
  /[A-Z]/.test(password) &&
  /\d/.test(password);

/**
 * Reset tokens go to the user by email and only their hash is stored, so a
 * leaked database row cannot be used to reset the password.
 */
export const hashResetToken = (token) =>
  createHash('sha256').update(String(token)).digest('hex');
