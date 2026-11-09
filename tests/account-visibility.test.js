import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { createAccount, createCard, createUser } from './helpers.js';

const CASES = [
  ['/api/accounts', createAccount],
  ['/api/cards', createCard],
];

describe.each(CASES)('PATCH %s/:id/visibility', (base, create) => {
  const patch = (auth, id, body) =>
    request(app).patch(`${base}/${id}/visibility`).set(auth).send(body);

  it('hides and restores without deleting', async () => {
    const { user, auth } = await createUser();
    const item = await create(user);

    await patch(auth, item.id, { isHidden: true });
    const hidden = await request(app).get(base).set(auth);
    expect(hidden.body.find((x) => x.id === item.id).isHidden).toBe(true);

    await patch(auth, item.id, { isHidden: false });
    const shown = await request(app).get(base).set(auth);
    expect(shown.body.find((x) => x.id === item.id).isHidden).toBe(false);
  });

  it('rejects anything but a boolean', async () => {
    const { user, auth } = await createUser();
    const item = await create(user);

    const res = await patch(auth, item.id, { isHidden: 'yes' });

    expect(res.status).toBe(400);
  });

  it("cannot change another user's item", async () => {
    const owner = await createUser();
    const intruder = await createUser();
    const item = await create(owner.user);

    const res = await patch(intruder.auth, item.id, { isHidden: true });

    expect(res.status).toBe(404);
  });
});

describe('hidden accounts in the history', () => {
  it('still reports a hidden account, so totals keep counting it', async () => {
    const { user, auth } = await createUser();
    const item = await createAccount(user, 'Oculta', { initialBalance: 40 });
    await request(app)
      .patch(`/api/accounts/${item.id}/visibility`)
      .set(auth)
      .send({ isHidden: true });

    const res = await request(app).get('/api/accounts/history').set(auth);

    expect(res.body.find((r) => r.accountId === item.id).balance).toBe(40);
  });
});
