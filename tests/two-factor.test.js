import request from 'supertest';
import bcrypt from 'bcrypt';
import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { resetRateLimits } from '../src/middleware/rateLimit.js';
import { base32Decode, base32Encode, hotp, stepAt, verifyTotp } from '../src/utils/totp.js';
import { decryptSecret, encryptSecret } from '../src/utils/twoFactor.js';
import { createUser } from './helpers.js';

const PASSWORD = 'Original1';
let user;
let auth;

const codeFor = (secret, step = stepAt()) => hotp(base32Decode(secret), step);
const login = () =>
  request(app).post('/api/auth/login').send({ email: user.email, password: PASSWORD });
const verify = (body) => request(app).post('/api/auth/2fa/verify').send(body);

/** Turns 2FA on through the API; returns the secret, recovery codes and step used. */
async function enableTwoFactor() {
  const setup = await request(app).post('/api/user/2fa/setup').set(auth).send({ password: PASSWORD });
  expect(setup.status).toBe(200);
  const step = stepAt() - 1;
  const enable = await request(app)
    .post('/api/user/2fa/enable')
    .set(auth)
    .send({ code: codeFor(setup.body.secret, step) });
  expect(enable.status).toBe(200);
  return { secret: setup.body.secret, recoveryCodes: enable.body.recoveryCodes, step };
}

beforeEach(async () => {
  resetRateLimits();
  ({ user, auth } = await createUser());
  await user.update({ passwordHash: await bcrypt.hash(PASSWORD, 10), isEmailVerified: true });
});

describe('TOTP', () => {
  // RFC 6238 appendix B, SHA-1, 8 digits.
  it('matches the RFC test vectors', () => {
    const key = Buffer.from('12345678901234567890');
    expect(hotp(key, Math.floor(59 / 30), 8)).toBe('94287082');
    expect(hotp(key, Math.floor(1111111109 / 30), 8)).toBe('07081804');
    expect(hotp(key, Math.floor(1234567890 / 30), 8)).toBe('89005924');
    expect(hotp(key, Math.floor(2000000000 / 30), 8)).toBe('69279037');
  });

  it('round-trips base32 and accepts one step of drift only', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    const now = 1_700_000_000_000;
    const step = stepAt(now);
    expect(verifyTotp(secret, codeFor(secret, step - 1), { now })).toBe(step - 1);
    expect(verifyTotp(secret, codeFor(secret, step - 2), { now })).toBeNull();
    expect(verifyTotp(secret, codeFor(secret, step), { now, lastStep: step })).toBeNull();
  });

  it('encrypts the secret and refuses a tampered value', () => {
    const stored = encryptSecret('ABCDEF');
    expect(stored).not.toContain('ABCDEF');
    expect(decryptSecret(stored)).toBe('ABCDEF');
    const [iv, tag, data] = stored.split('.');
    expect(() => decryptSecret([iv, tag, data.slice(0, -2) + 'AA'].join('.'))).toThrow();
  });
});

describe('two-step sign-in', () => {
  it('needs the password to start and a valid code to turn on', async () => {
    const noPwd = await request(app).post('/api/user/2fa/setup').set(auth).send({ password: 'wrong' });
    expect(noPwd.status).toBe(400);

    const setup = await request(app).post('/api/user/2fa/setup').set(auth).send({ password: PASSWORD });
    expect(setup.body.qr).toMatch(/^data:image\/png;base64,/);
    expect(setup.body.otpauthUrl).toContain(`secret=${setup.body.secret}`);
    const bad = await request(app).post('/api/user/2fa/enable').set(auth).send({ code: '000000' });
    expect(bad.status).toBe(400);
    expect((await request(app).get('/api/user/me').set(auth)).body.twoFactorEnabled).toBe(false);
  });

  it('asks for the code after the password and only then gives a session', async () => {
    const { secret, recoveryCodes, step } = await enableTwoFactor();
    expect(recoveryCodes).toHaveLength(10);

    const first = await login();
    expect(first.status).toBe(200);
    expect(first.body.token).toBeUndefined();
    expect(first.body.twoFactorRequired).toBe(true);

    // The challenge is not a session.
    const asSession = await request(app)
      .get('/api/user/me')
      .set({ Authorization: `Bearer ${first.body.challengeToken}` });
    expect(asSession.status).toBe(401);

    // The code used to turn it on can't be replayed.
    const replay = await verify({ challengeToken: first.body.challengeToken, code: codeFor(secret, step) });
    expect(replay.status).toBe(400);

    const ok = await verify({ challengeToken: first.body.challengeToken, code: codeFor(secret) });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeTruthy();
    const me = await request(app).get('/api/user/me').set({ Authorization: `Bearer ${ok.body.token}` });
    expect(me.body.twoFactorEnabled).toBe(true);
  });

  it('accepts each recovery code once', async () => {
    const { recoveryCodes } = await enableTwoFactor();
    const { challengeToken } = (await login()).body;
    const code = recoveryCodes[0].toUpperCase();
    expect((await verify({ challengeToken, recoveryCode: code })).status).toBe(200);
    expect((await verify({ challengeToken, recoveryCode: code })).status).toBe(400);
    const status = await request(app).get('/api/user/2fa').set(auth);
    expect(status.body).toMatchObject({ enabled: true, recoveryCodesLeft: 9 });
  });

  it('rejects a session token used as a challenge and limits guesses', async () => {
    await enableTwoFactor();
    const session = auth.Authorization.replace('Bearer ', '');
    expect((await verify({ challengeToken: session, code: '123456' })).status).toBe(401);
    resetRateLimits();

    const { challengeToken } = (await login()).body;
    for (let i = 0; i < 5; i += 1) {
      expect((await verify({ challengeToken, code: '000000' })).status).toBe(400);
    }
    expect((await verify({ challengeToken, code: '000000' })).status).toBe(429);
  });

  it('turns off with password and code, or by a super admin', async () => {
    const { secret } = await enableTwoFactor();
    const noCode = await request(app).post('/api/user/2fa/disable').set(auth).send({ password: PASSWORD, code: '000000' });
    expect(noCode.status).toBe(400);
    const off = await request(app)
      .post('/api/user/2fa/disable')
      .set(auth)
      .send({ password: PASSWORD, code: codeFor(secret) });
    expect(off.body.enabled).toBe(false);
    expect((await login()).body.token).toBeTruthy();

    await enableTwoFactor();
    const admin = await createUser();
    await admin.user.update({ isSuperAdmin: true });
    const reset = await request(app).patch(`/api/admin/users/${user.id}/reset-2fa`).set(admin.auth);
    expect(reset.status).toBe(200);
    expect((await login()).body.token).toBeTruthy();
  });
});
