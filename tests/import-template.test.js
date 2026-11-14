import request from 'supertest';
import ExcelJS from 'exceljs';
import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { createCategory, createUser } from './helpers.js';

let user;
let auth;

const download = (query = {}) =>
  request(app)
    .get('/api/import/template')
    .query(query)
    .set(auth)
    .buffer(true)
    .parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });

const open = async (buffer) => {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer);
  return book;
};

beforeEach(async () => {
  ({ user, auth } = await createUser());
  await user.update({ language: 'es' });
  await createCategory(user, 'Comida');
  await createCategory(user, 'Hogar, luz y agua');
  await createCategory(user, 'Salario', 'income');
});

describe('GET /api/import/template', () => {
  it('returns an empty Spanish template with validation on every column', async () => {
    const res = await download();
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain(
      'plantilla-transacciones.xlsx',
    );
    const book = await open(res.body);
    const sheet = book.getWorksheet('Transacciones');
    expect(sheet.getRow(1).values.slice(1)).toEqual([
      'Fecha',
      'Descripción',
      'Monto',
      'Tipo',
      'Categoría',
    ]);
    expect(sheet.actualRowCount).toBe(1);
    expect(book.getWorksheet('Instrucciones')).toBeTruthy();

    const rules = sheet.dataValidations.model;
    const at = (col) =>
      Object.entries(rules).find(([range]) => range.startsWith(`${col}2`))?.[1];
    expect(at('A')).toMatchObject({
      type: 'date',
      operator: 'between',
      showErrorMessage: true,
    });
    expect(at('B')).toMatchObject({ type: 'textLength', formulae: [1, 255] });
    expect(at('C')).toMatchObject({
      type: 'decimal',
      formulae: [0.01, 999999999.99],
    });
    expect(at('D').formulae[0]).toBe('"Gasto,Ingreso"');
    // Categories come from a hidden sheet, so names with commas still work.
    expect(at('E').formulae[0]).toBe('lists!$A$1:$A$3');
    const lists = book.getWorksheet('lists');
    expect(lists.state).toBe('veryHidden');
    expect(lists.getColumn(1).values.filter(Boolean)).toEqual([
      'Comida',
      'Hogar, luz y agua',
      'Salario',
    ]);
  });

  it('fills the example with 15 rows that use only the user own categories', async () => {
    const book = await open((await download({ demo: '1' })).body);
    const sheet = book.getWorksheet('Transacciones');
    const rows = [];
    sheet.eachRow((row, i) => i > 1 && rows.push(row.values.slice(1)));
    expect(rows).toHaveLength(15);
    for (const [date, description, amount, type, category] of rows) {
      expect(date).toBeInstanceOf(Date);
      expect(description.length).toBeGreaterThan(0);
      expect(amount).toBeGreaterThan(0);
      expect(['Gasto', 'Ingreso']).toContain(type);
      if (category) {
        expect(['Comida', 'Hogar, luz y agua', 'Salario']).toContain(category);
        expect(category === 'Salario').toBe(type === 'Ingreso');
      }
    }
  });

  it('follows the user language', async () => {
    await user.update({ language: 'en' });
    const res = await download({ demo: '1' });
    expect(res.headers['content-disposition']).toContain(
      'transactions-example.xlsx',
    );
    const sheet = (await open(res.body)).getWorksheet('Transactions');
    expect(sheet.getRow(1).values.slice(1)).toEqual([
      'Date',
      'Description',
      'Amount',
      'Type',
      'Category',
    ]);
    expect(sheet.getRow(2).values[4]).toMatch(/^(Expense|Income)$/);
  });

  it('requires a session', async () => {
    const res = await request(app).get('/api/import/template');
    expect(res.status).toBe(401);
  });
});
