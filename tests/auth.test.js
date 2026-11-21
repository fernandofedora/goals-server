import request from 'supertest';
import bcrypt from 'bcrypt';
import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { User } from '../src/models/index.js';
import { sendResetPasswordEmail } from '../src/utils/mail.js';
import { resetRateLimits } from '../src/middleware/rateLimit.js';
import { hashResetToken } from '../src/utils/password.js';
import { createUser } from './helpers.js';

const PASSWORD = 'Original1';

async function userWithPassword(fields = {}) {
  const { user, auth } = await createUser();
  await user.update({
    passwordHash: await bcrypt.hash(PASSWORD, 10),
    isEmailVerified: true,
    ...fields,
  });
  return { user, auth };
}

const resetStart = (email) =>
  request(app).post('/api/auth/reset-start').send({ email });

/** Token that reset-start mailed to `email` (the mail module is mocked). */
const mailedToken = (email) => {
  const call = sendResetPasswordEmail.mock.calls.findLast(([to]) => to === email);
  return call?.[2];
};

beforeEach(() => {
  resetRateLimits();
  sendResetPasswordEmail.mockClear();
});

describe('POST /api/auth/reset-start', () => {
  it('answers the same for registered and unknown emails', async () => {
    const { user } = await userWithPassword();
    const known = await resetStart(user.email);
    const unknown = await resetStart('nobody@local.test');

    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.body).toEqual(unknown.body);
    expect(sendResetPasswordEmail).toHaveBeenCalledTimes(1);
  });

  it('stores only the hash of the mailed token', async () => {
    const { user } = await userWithPassword();
    await resetStart(user.email);
    const token = mailedToken(user.email);
    await user.reload();

    expect(token).toBeTruthy();
    expect(user.resetPasswordToken).toBe(hashResetToken(token));
    expect(user.resetPasswordToken).not.toBe(token);
  });

  it('sends nothing to a deactivated account', async () => {
    const { user } = await userWithPassword({ isActive: false });
    const res = await resetStart(user.email);
    expect(res.status).toBe(200);
    expect(sendResetPasswordEmail).not.toHaveBeenCalled();
  });

  it('limits requests per email', async () => {
    const { user } = await userWithPassword();
    for (let i = 0; i < 3; i += 1) {
      expect((await resetStart(user.email)).status).toBe(200);
    }
    const blocked = await resetStart(user.email);
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
  });
});

describe('POST /api/auth/reset-password', () => {
  it('changes the password with the mailed token, once', async () => {
    const { user } = await userWithPassword({ isEmailVerified: false });
    await resetStart(user.email);
    const token = mailedToken(user.email);

    const ok = await request(app)
      .post('/api/auth/reset-password')
      .send({ token, password: 'Newpass123' });
    expect(ok.status).toBe(200);

    await user.reload();
    expect(await bcrypt.compare('Newpass123', user.passwordHash)).toBe(true);
    expect(user.resetPasswordToken).toBeNull();
    expect(user.isEmailVerified).toBe(true);

    const again = await request(app)
      .post('/api/auth/reset-password')
      .send({ token, password: 'Another123' });
    expect(again.status).toBe(400);
  });

  it('rejects the stored hash used as a token', async () => {
    const { user } = await userWithPassword();
    await resetStart(user.email);
    await user.reload();

    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: user.resetPasswordToken, password: 'Newpass123' });
    expect(res.status).toBe(400);
  });

  it('rejects a short password', async () => {
    const { user } = await userWithPassword();
    await resetStart(user.email);

    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: mailedToken(user.email), password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Weak password');
  });
});

describe('POST /api/auth/login', () => {
  const login = (email, password) =>
    request(app).post('/api/auth/login').send({ email, password });

  it('logs in with the right password', async () => {
    const { user } = await userWithPassword();
    const res = await login(user.email, PASSWORD);
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  });

  it('gives the same answer for an unknown email and a wrong password', async () => {
    const { user } = await userWithPassword();
    const wrong = await login(user.email, 'Wrong1234');
    const unknown = await login('nobody@local.test', 'Wrong1234');
    expect(wrong.status).toBe(400);
    expect(unknown.status).toBe(400);
    expect(wrong.body).toEqual(unknown.body);
  });

  it('does not reveal a deactivated account to a wrong password', async () => {
    const { user } = await userWithPassword({ isActive: false });
    expect((await login(user.email, 'Wrong1234')).status).toBe(400);
    expect((await login(user.email, PASSWORD)).status).toBe(403);
  });

  it('limits attempts per email', async () => {
    const { user } = await userWithPassword();
    for (let i = 0; i < 10; i += 1) {
      expect((await login(user.email, 'Wrong1234')).status).toBe(400);
    }
    expect((await login(user.email, PASSWORD)).status).toBe(429);
  });
});

describe('POST /api/auth/register', () => {
  it('rejects a short password', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'X', email: 'short-pwd@local.test', password: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Weak password');
    expect(await User.findOne({ where: { email: 'short-pwd@local.test' } })).toBeNull();
  });
});

describe('POST /api/user/change-password', () => {
  it('accepts a password with lower, upper case and a digit', async () => {
    const { auth } = await userWithPassword();
    const res = await request(app)
      .post('/api/user/change-password')
      .set(auth)
      .send({ currentPassword: PASSWORD, newPassword: 'Abcdefg1' });
    expect(res.status).toBe(200);
  });

  it('rejects a password without a digit', async () => {
    const { auth } = await userWithPassword();
    const res = await request(app)
      .post('/api/user/change-password')
      .set(auth)
      .send({ currentPassword: PASSWORD, newPassword: 'Abcdefgh' });
    expect(res.status).toBe(400);
  });
});
