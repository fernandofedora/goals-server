import ExcelJS from 'exceljs';
import { COLUMNS, HEADERS, LIMITS } from './importTemplate.js';
import { listZipEntries, looksLikeZip } from './zipInspect.js';
import { normalizeText } from './categoryRules.js';

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
// An honest 5 MB spreadsheet unpacks to a few tens of MB; more is a zip bomb.
const MAX_UNPACKED_BYTES = 60 * 1024 * 1024;

const XLSX_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream',
]);
const CSV_TYPES = new Set([
  'text/csv',
  'text/plain',
  'application/csv',
  'application/vnd.ms-excel', // what Windows browsers send for .csv
  'application/octet-stream',
]);

const fail = (code) => ({ error: code });

const headerMatches = (cells) =>
  Object.values(HEADERS).some((labels) =>
    COLUMNS.every(
      (key, i) => normalizeText(cells[i]) === normalizeText(labels[key]),
    ),
  );

const isBlank = (cells) =>
  cells.every((v) => v === null || v === undefined || String(v).trim() === '');

/** Plain value of an exceljs cell, flagging formulas instead of evaluating them. */
function cellValue(value) {
  if (value === null || value === undefined) return { value: null };
  if (value instanceof Date || typeof value !== 'object') return { value };
  if ('formula' in value || 'sharedFormula' in value)
    return { value: null, formula: true };
  if (Array.isArray(value.richText))
    return { value: value.richText.map((r) => r.text).join('') };
  if ('text' in value) return { value: value.text };
  if ('error' in value) return { value: String(value.error) };
  return { value: String(value) };
}

async function readXlsx(buffer) {
  if (!looksLikeZip(buffer)) return fail('FILE_TYPE');
  const entries = listZipEntries(buffer);
  if (!entries) return fail('FILE_CORRUPT');
  const names = entries.map((e) => e.name.toLowerCase());
  if (
    !names.includes('xl/workbook.xml') ||
    !names.includes('[content_types].xml')
  ) {
    return fail('FILE_TYPE');
  }
  if (
    names.some((n) => n.endsWith('vbaproject.bin') || n.includes('activex'))
  ) {
    return fail('FILE_MACROS');
  }
  const unpacked = entries.reduce((sum, e) => sum + e.uncompressedSize, 0);
  if (unpacked > MAX_UNPACKED_BYTES) return fail('FILE_TOO_LARGE');

  const book = new ExcelJS.Workbook();
  try {
    await book.xlsx.load(buffer);
  } catch {
    return fail('FILE_CORRUPT');
  }
  const sheet =
    book.worksheets.find((ws) =>
      ['transacciones', 'transactions'].includes(normalizeText(ws.name)),
    ) || book.worksheets.find((ws) => ws.state === 'visible');
  if (!sheet) return fail('FILE_EMPTY');

  const header = COLUMNS.map(
    (_, i) => cellValue(sheet.getRow(1).getCell(i + 1).value).value,
  );
  if (!headerMatches(header)) return fail('FILE_HEADERS');

  const rows = [];
  let tooMany = false;
  sheet.eachRow({ includeEmpty: false }, (row, number) => {
    if (number === 1 || tooMany) return;
    const read = COLUMNS.map((_, i) => cellValue(row.getCell(i + 1).value));
    const cells = read.map((c) => c.value);
    if (isBlank(cells) && !read.some((c) => c.formula)) return;
    if (rows.length >= LIMITS.maxRows) {
      tooMany = true;
      return;
    }
    rows.push({ row: number, cells, formula: read.some((c) => c.formula) });
  });
  if (tooMany) return fail('FILE_TOO_MANY_ROWS');
  return { rows };
}

function decodeText(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    // Excel's plain "CSV" on Windows is Windows-1252, not UTF-8.
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

/** RFC 4180 CSV: quoted fields, doubled quotes, any line ending. */
function parseCsv(text, delimiter, maxRecords) {
  const records = [];
  let field = '';
  let record = [];
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) {
      record.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      if (records.length > maxRecords) return records;
    } else field += ch;
  }
  if (field !== '' || record.length) {
    record.push(field);
    records.push(record);
  }
  return records;
}

function readCsv(buffer) {
  if (looksLikeZip(buffer) || buffer.includes(0)) return fail('FILE_TYPE');
  const text = decodeText(buffer).replace(/^﻿/, '');
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const delimiter = [';', '\t', ','].reduce((best, d) =>
    firstLine.split(d).length > firstLine.split(best).length ? d : best,
  );
  // Header + max rows + one more to detect overflow; blank lines are dropped below.
  const records = parseCsv(text, delimiter, LIMITS.maxRows + 1 + 50);
  if (!records.length) return fail('FILE_EMPTY');
  if (!headerMatches(records[0])) return fail('FILE_HEADERS');

  const rows = [];
  for (let i = 1; i < records.length; i += 1) {
    const cells = COLUMNS.map((_, c) => records[i][c] ?? null);
    if (isBlank(cells)) continue;
    if (rows.length >= LIMITS.maxRows) return fail('FILE_TOO_MANY_ROWS');
    rows.push({ row: i + 1, cells, formula: false });
  }
  return { rows, csv: true };
}

/**
 * Reads an uploaded import file. Checks extension, declared type and the bytes
 * themselves, so a renamed or disguised file is refused.
 * Returns `{ rows: [{ row, cells: [date, description, amount, type, category], formula }] }`
 * or `{ error: 'FILE_…' }`.
 */
export async function readImportFile(file) {
  if (!file?.buffer?.length) return fail('FILE_REQUIRED');
  if (file.buffer.length > MAX_FILE_BYTES) return fail('FILE_TOO_LARGE');
  const name = String(file.originalname || '').toLowerCase();
  const mime = String(file.mimetype || '').toLowerCase();
  if (name.endsWith('.xlsx') && XLSX_TYPES.has(mime))
    return readXlsx(file.buffer);
  if (name.endsWith('.csv') && CSV_TYPES.has(mime)) return readCsv(file.buffer);
  return fail('FILE_TYPE');
}
