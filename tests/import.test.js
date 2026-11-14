import request from 'supertest';
import ExcelJS from 'exceljs';
import zlib from 'zlib';
import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import {
  Account,
  CategoryRule,
  Transaction,
  User,
} from '../src/models/index.js';
import {
  createAccount,
  createCard,
  createCategory,
  createUser,
} from './helpers.js';

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const HEAD = ['Fecha', 'Descripción', 'Monto', 'Tipo', 'Categoría'];

let user;
let auth;
let bank;
let food;

async function xlsx(rows, { header = HEAD, sheetName = 'Transacciones' } = {}) {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet(sheetName);
  sheet.addRow(header);
  for (const r of rows) sheet.addRow(r);
  return Buffer.from(await book.xlsx.writeBuffer());
}

const csv = (lines, sep = ',') =>
  Buffer.from(
    [HEAD.join(sep), ...lines.map((l) => l.join(sep))].join('\r\n'),
    'utf8',
  );

/** A minimal stored (uncompressed) ZIP; `declare` can lie about sizes. */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data = Buffer.alloc(0), declare } of entries) {
    const nameBuf = Buffer.from(name);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(declare ?? data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(declare ?? data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

const send = (
  path,
  buffer,
  { name = 'datos.xlsx', type = XLSX_MIME, target, include, as = auth } = {},
) => {
  const req = request(app)
    .post(`/api/import/${path}`)
    .set(as)
    .field('target', target ?? `account:${bank.id}`);
  if (include) req.field('include', JSON.stringify(include));
  return buffer
    ? req.attach('file', buffer, { filename: name, contentType: type })
    : req;
};
const preview = (buffer, opts) => send('preview', buffer, opts);
const commit = (buffer, opts) => send('commit', buffer, opts);

beforeEach(async () => {
  ({ user, auth } = await createUser());
  await user.update({ language: 'es' });
  bank = await createAccount(user, 'Banco');
  food = await createCategory(user, 'Comida');
  await createCategory(user, 'Salario', 'income');
});

describe('import flow', () => {
  it('imports the downloaded example as is, and a second time finds only duplicates', async () => {
    const demo = await request(app)
      .get('/api/import/template?demo=1')
      .set(auth)
      .buffer(true)
      .parse((res, cb) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    const first = await preview(demo.body);
    expect(first.status).toBe(200);
    expect(first.body.summary).toEqual({ ok: 15, duplicate: 0, error: 0 });

    const saved = await commit(demo.body);
    expect(saved.body).toMatchObject({ imported: 15 });
    expect(saved.body.batchId).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      await Transaction.count({
        where: {
          UserId: user.id,
          AccountId: bank.id,
          paymentMethod: 'account',
        },
      }),
    ).toBe(15);

    const again = await preview(demo.body);
    expect(again.body.summary).toEqual({ ok: 0, duplicate: 15, error: 0 });
    expect((await commit(demo.body)).body.imported).toBe(0);
  });

  it('reports each bad row with its reason and imports the good ones', async () => {
    const file = await xlsx([
      [new Date(Date.UTC(2026, 2, 10)), 'Súper', 25.5, 'Gasto', 'Comida'],
      ['2026-02-30', 'Fecha imposible', 10, 'Gasto', ''],
      ['1999-12-31', 'Muy vieja', 10, 'Gasto', ''],
      ['2026-03-11', '', 10, 'Gasto', ''],
      ['2026-03-11', 'x'.repeat(256), 10, 'Gasto', ''],
      ['2026-03-11', 'Negativo', -10, 'Gasto', ''],
      ['2026-03-11', 'Con símbolo', '$1,250.50', 'Gasto', ''],
      ['2026-03-11', 'Tres decimales', 10.125, 'Gasto', ''],
      ['2026-03-11', 'Tipo raro', 10, 'Transferencia', ''],
      ['2026-03-11', 'Categoría inventada', 10, 'Gasto', 'Viajes'],
      ['2026-03-11', 'Ingreso en Comida', 10, 'Ingreso', 'Comida'],
      ['2026-03-12', 'Salario', 1000, 'ingreso', 'salario'],
    ]);
    const res = await preview(file);
    const byRow = Object.fromEntries(res.body.rows.map((r) => [r.row, r]));
    expect(res.body.summary).toEqual({ ok: 2, duplicate: 0, error: 10 });
    expect(byRow[3].errors).toEqual(['DATE_INVALID']);
    expect(byRow[4].errors).toEqual(['DATE_OUT_OF_RANGE']);
    expect(byRow[5].errors).toEqual(['DESCRIPTION_REQUIRED']);
    expect(byRow[6].errors).toEqual(['DESCRIPTION_TOO_LONG']);
    expect(byRow[7].errors).toEqual(['AMOUNT_INVALID']);
    expect(byRow[8].errors).toEqual(['AMOUNT_INVALID']);
    expect(byRow[9].errors).toEqual(['AMOUNT_DECIMALS']);
    expect(byRow[10].errors).toEqual(['TYPE_INVALID']);
    expect(byRow[11].errors).toEqual(['CATEGORY_NOT_FOUND']);
    expect(byRow[12].errors).toEqual(['CATEGORY_TYPE_MISMATCH']);
    // Names and types match without caring about case or accents.
    expect(byRow[13]).toMatchObject({
      status: 'ok',
      type: 'income',
      categoryName: 'Salario',
    });

    // Even if the client asks for error rows, only valid ones are saved.
    const saved = await commit(file, { include: [2, 3, 7, 13] });
    expect(saved.body.imported).toBe(2);
  });

  it('reads a Spanish Excel CSV: semicolons, decimal comma, day-first dates, Windows encoding', async () => {
    const text = [
      'Fecha;Descripción;Monto;Tipo;Categoría',
      '13/03/2026;Panadería;12,50;Gasto;Comida',
    ].join('\r\n');
    const res = await preview(Buffer.from(text, 'latin1'), {
      name: 'datos.csv',
      type: 'application/vnd.ms-excel',
    });
    expect(res.status).toBe(200);
    expect(res.body.rows[0]).toMatchObject({
      status: 'ok',
      date: '2026-03-13',
      description: 'Panadería',
      amount: 12.5,
      categoryName: 'Comida',
    });
  });

  it('fills empty categories with the user rules', async () => {
    await CategoryRule.create({
      UserId: user.id,
      name: 'Uber',
      field: 'description',
      operator: 'contains',
      value: 'uber',
      CategoryId: food.id,
      priority: 1,
    });
    const res = await preview(
      csv([['2026-03-10', 'UBER viaje', '7', 'Gasto', '']]),
      { name: 'a.csv', type: 'text/csv' },
    );
    expect(res.body.rows[0]).toMatchObject({
      categoryName: 'Comida',
      ruleName: 'Uber',
    });
  });

  it('keeps two identical rows when only one was already saved', async () => {
    const rows = [
      ['2026-03-10', 'Café', '3', 'Gasto', ''],
      ['2026-03-10', 'Café', '3', 'Gasto', ''],
    ];
    await commit(csv(rows.slice(0, 1)), { name: 'a.csv', type: 'text/csv' });
    const res = await preview(csv(rows), { name: 'a.csv', type: 'text/csv' });
    expect(res.body.summary).toEqual({ ok: 1, duplicate: 1, error: 0 });
  });

  it('imports to a card or as cash, and undo removes only that batch', async () => {
    const card = await createCard(user, 'Visa');
    const file = csv([['2026-03-10', 'Libro', '20', 'Gasto', '']]);
    const one = await commit(file, {
      name: 'a.csv',
      type: 'text/csv',
      target: `card:${card.id}`,
    });
    const two = await commit(file, {
      name: 'a.csv',
      type: 'text/csv',
      target: 'cash',
    });
    expect(
      (
        await Transaction.findOne({
          where: { importBatchId: one.body.batchId },
        })
      ).CardId,
    ).toBe(card.id);
    expect(
      (
        await Transaction.findOne({
          where: { importBatchId: two.body.batchId },
        })
      ).paymentMethod,
    ).toBe('cash');

    const batches = await request(app).get('/api/import/batches').set(auth);
    expect(batches.body.map((b) => b.importBatchId)).toEqual(
      expect.arrayContaining([one.body.batchId, two.body.batchId]),
    );

    const other = await createUser();
    expect(
      (
        await request(app)
          .delete(`/api/import/batches/${one.body.batchId}`)
          .set(other.auth)
      ).status,
    ).toBe(404);
    const undo = await request(app)
      .delete(`/api/import/batches/${one.body.batchId}`)
      .set(auth);
    expect(undo.body.deleted).toBe(1);
    expect(
      await Transaction.count({ where: { importBatchId: two.body.batchId } }),
    ).toBe(1);
  });
});

describe('import security', () => {
  it('stores SQL injection attempts as plain text and leaves the database intact', async () => {
    const payload = "'; DROP TABLE Transactions; --";
    const file = await xlsx([
      ['2026-03-10', payload, 1, 'Gasto', "Comida' OR '1'='1"],
      ['2026-03-10', payload, 1, 'Gasto', ''],
    ]);
    const res = await commit(file, { include: [2, 3] });
    expect(res.body.imported).toBe(1); // the row with the injected category name does not exist
    const saved = await Transaction.findOne({
      where: { importBatchId: res.body.batchId },
    });
    expect(saved.description).toBe(payload);
    expect(await User.count()).toBeGreaterThan(0);
    expect(await Account.count({ where: { id: bank.id } })).toBe(1);
  });

  it('rejects formula cells instead of evaluating them', async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Transacciones');
    sheet.addRow(HEAD);
    sheet.addRow([
      '2026-03-10',
      { formula: 'HYPERLINK("http://evil.test","clic")' },
      10,
      'Gasto',
      '',
    ]);
    const res = await preview(Buffer.from(await book.xlsx.writeBuffer()));
    expect(res.body.rows[0].errors).toContain('FORMULA_NOT_ALLOWED');
  });

  it('keeps a description that looks like a formula as text', async () => {
    const res = await preview(csv([['2026-03-10', '=1+1', '5', 'Gasto', '']]), {
      name: 'a.csv',
      type: 'text/csv',
    });
    expect(res.body.rows[0]).toMatchObject({
      status: 'ok',
      description: '=1+1',
    });
  });

  it('rejects files that are not what they claim', async () => {
    const real = await xlsx([]);
    expect(
      (await preview(Buffer.from('hola, no soy excel'), {})).body.code,
    ).toBe('FILE_TYPE');
    expect(
      (await preview(real, { name: 'datos.csv', type: 'text/csv' })).body.code,
    ).toBe('FILE_TYPE');
    expect(
      (
        await preview(real, {
          name: 'datos.exe',
          type: 'application/octet-stream',
        })
      ).body.code,
    ).toBe('FILE_TYPE');
    expect(
      (await preview(real, { name: 'datos.xlsm', type: XLSX_MIME })).body.code,
    ).toBe('FILE_TYPE');
    expect(
      (
        await preview(Buffer.from([0x4d, 0x5a, 0, 1, 2]), {
          name: 'a.csv',
          type: 'text/csv',
        })
      ).body.code,
    ).toBe('FILE_TYPE');
  });

  it('rejects workbooks with macros and zip bombs before opening them', async () => {
    const base = [{ name: '[Content_Types].xml' }, { name: 'xl/workbook.xml' }];
    const macro = zip([
      ...base,
      { name: 'xl/vbaProject.bin', data: Buffer.from('x') },
    ]);
    expect((await preview(macro)).body.code).toBe('FILE_MACROS');
    const bomb = zip([
      ...base,
      {
        name: 'xl/worksheets/sheet1.xml',
        data: Buffer.from('x'),
        declare: 900 * 1024 * 1024,
      },
    ]);
    const res = await preview(bomb);
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('FILE_TOO_LARGE');
  });

  it('enforces size, row and header limits', async () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 1, 'a');
    const tooBig = await preview(big, { name: 'a.csv', type: 'text/csv' });
    expect(tooBig.status).toBe(413);
    expect(tooBig.body.code).toBe('FILE_TOO_LARGE');

    const many = csv(
      Array.from({ length: 5001 }, (_, i) => [
        '2026-03-10',
        `Fila ${i}`,
        '1',
        'Gasto',
        '',
      ]),
    );
    expect(
      (await preview(many, { name: 'a.csv', type: 'text/csv' })).body.code,
    ).toBe('FILE_TOO_MANY_ROWS');

    const wrong = await xlsx([], {
      header: ['Date', 'Amount', 'Description', 'Type', 'Category'],
    });
    expect((await preview(wrong)).body.code).toBe('FILE_HEADERS');
    expect((await preview(null)).body.code).toBe('FILE_REQUIRED');
  });

  it('only imports into the user own accounts and validates the selection', async () => {
    const other = await createUser();
    const foreign = await createAccount(other.user, 'Ajena');
    const file = csv([['2026-03-10', 'Algo', '5', 'Gasto', '']]);
    expect(
      (
        await commit(file, {
          name: 'a.csv',
          type: 'text/csv',
          target: `account:${foreign.id}`,
        })
      ).body.code,
    ).toBe('TARGET_INVALID');
    expect(
      (
        await commit(file, {
          name: 'a.csv',
          type: 'text/csv',
          target: 'account:1 OR 1=1',
        })
      ).body.code,
    ).toBe('TARGET_INVALID');
    const bad = await request(app)
      .post('/api/import/commit')
      .set(auth)
      .field('target', `account:${bank.id}`)
      .field('include', '{"row": "DROP"}')
      .attach('file', file, { filename: 'a.csv', contentType: 'text/csv' });
    expect(bad.body.code).toBe('INCLUDE_INVALID');
  });
});
