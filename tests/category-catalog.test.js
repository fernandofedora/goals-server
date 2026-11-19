import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { Category, User } from '../src/models/index.js';
import { addSuggestedCategories } from '../src/utils/categoryCatalog.js';
import { createCategory, createUser } from './helpers.js';

let user;
let auth;

beforeEach(async () => {
  ({ user, auth } = await createUser());
});

const mine = () => Category.findAll({ where: { UserId: user.id } });

describe('suggested categories catalog', () => {
  it('creates 22 top-level categories and 32 subcategories in Spanish', async () => {
    expect(await addSuggestedCategories(user.id, 'es')).toBe(54);
    const cats = await mine();
    expect(cats.filter((c) => !c.parentId)).toHaveLength(22);
    const home = cats.find((c) => c.name === 'Hogar');
    const homeKids = cats.filter((c) => c.parentId === home.id).map((c) => c.name);
    expect(homeKids).toEqual(expect.arrayContaining(['Luz', 'Agua', 'Alquiler o hipoteca']));
    expect(cats.find((c) => c.name === 'Pago de tarjeta').type).toBe('transfer');
    expect(cats.find((c) => c.name === 'Dividendos').type).toBe('income');
  });

  it('uses English for any other language', async () => {
    await addSuggestedCategories(user.id, 'en');
    const names = (await mine()).map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['Home', 'Groceries', 'Card payment']));
  });

  it('only adds what is missing and never touches existing categories', async () => {
    const food = await createCategory(user, 'COMIDA', 'expense', { color: '#000000', monthlyBudget: 300 });
    const mine1 = await createCategory(user, 'Mi categoría');
    const created = await addSuggestedCategories(user.id, 'es');
    expect(created).toBe(53);
    await food.reload();
    expect(food).toMatchObject({ name: 'COMIDA', color: '#000000' });
    expect(Number(food.monthlyBudget)).toBe(300);
    // Its suggested subcategories hang from the user's own "COMIDA".
    expect(await Category.count({ where: { parentId: food.id } })).toBe(3);
    expect(await Category.findByPk(mine1.id)).not.toBeNull();
    expect(await addSuggestedCategories(user.id, 'es')).toBe(0);
  });

  it('is exposed as POST /api/categories/suggested in the user language', async () => {
    await user.update({ language: 'es' });
    const res = await request(app).post('/api/categories/suggested').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(54);
    const again = await request(app).post('/api/categories/suggested').set(auth);
    expect(again.body.created).toBe(0);
  });
});

describe('registration', () => {
  it('stores the language and creates the catalog in it', async () => {
    const email = `catalog-${Date.now()}@local.test`;
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Nuevo', email, password: 'Secreta123', language: 'es' });
    expect(res.status).toBeLessThan(300);
    const created = await User.findOne({ where: { email } });
    expect(created.language).toBe('es');
    const cats = await Category.findAll({ where: { UserId: created.id } });
    expect(cats).toHaveLength(54);
    expect(cats.some((c) => c.name === 'Supermercado')).toBe(true);
  });
});
