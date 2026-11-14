import ExcelJS from 'exceljs';

// One definition of the import columns, shared by the template and the parser.
// Uploads are accepted with the headers of either language.
export const COLUMNS = ['date', 'description', 'amount', 'type', 'category'];

export const HEADERS = {
  es: {
    date: 'Fecha',
    description: 'Descripción',
    amount: 'Monto',
    type: 'Tipo',
    category: 'Categoría',
  },
  en: {
    date: 'Date',
    description: 'Description',
    amount: 'Amount',
    type: 'Type',
    category: 'Category',
  },
};

export const TYPE_LABELS = {
  es: { expense: 'Gasto', income: 'Ingreso' },
  en: { expense: 'Expense', income: 'Income' },
};

export const LIMITS = {
  maxRows: 5000,
  maxDescription: 255,
  maxAmount: 999999999.99,
  minDate: '2000-01-01',
};

const COPY = {
  es: {
    dataSheet: 'Transacciones',
    helpSheet: 'Instrucciones',
    file: (demo) =>
      demo ? 'ejemplo-transacciones.xlsx' : 'plantilla-transacciones.xlsx',
    errors: {
      date: [
        'Fecha no válida',
        'Escribe una fecha entre el 1 de enero de 2000 y dentro de un año, por ejemplo 2026-11-13.',
      ],
      description: [
        'Descripción no válida',
        'Escribe entre 1 y 255 caracteres.',
      ],
      amount: [
        'Monto no válido',
        'Escribe un número mayor que 0, con hasta 2 decimales y sin símbolo de moneda.',
      ],
      type: ['Tipo no válido', 'Elige Gasto o Ingreso de la lista.'],
      category: [
        'Categoría no válida',
        'Elige una de tus categorías de la lista o deja la celda vacía.',
      ],
    },
    help: [
      ['Cómo llenar la plantilla'],
      [],
      [
        '1. Escribe una transacción por fila en la hoja "Transacciones", desde la fila 2. No cambies los encabezados.',
      ],
      [
        '2. La cuenta o tarjeta se elige en la app al subir el archivo: usa un archivo por cuenta o tarjeta.',
      ],
      [
        '3. Si copias datos de tu banco, pégalos con "Pegar valores" para no arrastrar fórmulas ni formatos.',
      ],
      [],
      ['Columna', 'Obligatoria', 'Qué escribir', 'Ejemplo'],
      [
        'Fecha',
        'Sí',
        'Una fecha entre 2000-01-01 y un año a futuro. Formato AAAA-MM-DD.',
        '2026-11-13',
      ],
      [
        'Descripción',
        'Sí',
        'Entre 1 y 255 caracteres.',
        'Supermercado La Colonia',
      ],
      [
        'Monto',
        'Sí',
        'Número mayor que 0, hasta 2 decimales, sin símbolo de moneda ni signo.',
        '1250.50',
      ],
      ['Tipo', 'Sí', 'Gasto o Ingreso (elige de la lista).', 'Gasto'],
      [
        'Categoría',
        'No',
        'Una de tus categorías (elige de la lista). Si la dejas vacía, la ponen tus reglas.',
        'Comida',
      ],
      [],
      ['Errores comunes'],
      [
        '• Montos con símbolo o separador de miles ("$1,250.50"): escribe solo 1250.50.',
      ],
      [
        '• Montos negativos para gastos: el monto va siempre positivo y la columna Tipo indica si es gasto o ingreso.',
      ],
      [
        '• Fórmulas (celdas que empiezan con =): el archivo se rechaza. Pega solo valores.',
      ],
      [
        '• Archivos con macros (.xlsm) o de Excel antiguo (.xls): guarda como .xlsx o .csv.',
      ],
      [],
      [
        'Límites: 5 MB y 5,000 filas por archivo. Las filas con errores se muestran en la vista previa y no impiden importar las demás.',
      ],
      [
        'Si subes el mismo archivo dos veces, las transacciones repetidas se marcan como duplicadas y no se importan.',
      ],
    ],
    demo: [
      ['Supermercado', 'expense', 62.4, 'expense'],
      ['Salario de noviembre', 'income', 1500, 'income'],
      ['Gasolina', 'expense', 35, null],
      ['Restaurante', 'expense', 28.75, 'expense'],
      ['Luz', 'expense', 45.1, 'expense'],
      ['Farmacia', 'expense', 12.99, null],
      ['Internet', 'expense', 30, 'expense'],
      ['Venta de bicicleta usada', 'income', 120, null],
      ['Cine', 'expense', 9.5, 'expense'],
      ['Café', 'expense', 3.25, null],
      ['Reembolso de compra', 'income', 18.4, 'income'],
      ['Agua', 'expense', 15, 'expense'],
      ['Taxi', 'expense', 7.8, null],
      ['Ropa', 'expense', 54, 'expense'],
      ['Intereses de ahorro', 'income', 2.35, 'income'],
    ],
  },
  en: {
    dataSheet: 'Transactions',
    helpSheet: 'Instructions',
    file: (demo) =>
      demo ? 'transactions-example.xlsx' : 'transactions-template.xlsx',
    errors: {
      date: [
        'Invalid date',
        'Enter a date between January 1, 2000 and one year from now, for example 2026-11-13.',
      ],
      description: ['Invalid description', 'Enter 1 to 255 characters.'],
      amount: [
        'Invalid amount',
        'Enter a number above 0, with up to 2 decimals and no currency symbol.',
      ],
      type: ['Invalid type', 'Pick Expense or Income from the list.'],
      category: [
        'Invalid category',
        'Pick one of your categories from the list or leave the cell empty.',
      ],
    },
    help: [
      ['How to fill in the template'],
      [],
      [
        '1. Write one transaction per row on the "Transactions" sheet, starting at row 2. Do not change the headers.',
      ],
      [
        '2. You pick the account or card in the app when you upload: use one file per account or card.',
      ],
      [
        '3. If you copy data from your bank, use "Paste values" so no formulas or formats come along.',
      ],
      [],
      ['Column', 'Required', 'What to enter', 'Example'],
      [
        'Date',
        'Yes',
        'A date between 2000-01-01 and one year from now. Format YYYY-MM-DD.',
        '2026-11-13',
      ],
      ['Description', 'Yes', '1 to 255 characters.', 'Corner grocery store'],
      [
        'Amount',
        'Yes',
        'A number above 0, up to 2 decimals, no currency symbol or sign.',
        '1250.50',
      ],
      ['Type', 'Yes', 'Expense or Income (pick from the list).', 'Expense'],
      [
        'Category',
        'No',
        'One of your categories (pick from the list). Leave it empty and your rules fill it in.',
        'Food',
      ],
      [],
      ['Common mistakes'],
      [
        '• Amounts with a symbol or thousands separator ("$1,250.50"): write just 1250.50.',
      ],
      [
        '• Negative amounts for expenses: the amount is always positive and the Type column says expense or income.',
      ],
      [
        '• Formulas (cells starting with =): the file is rejected. Paste values only.',
      ],
      [
        '• Files with macros (.xlsm) or old Excel files (.xls): save as .xlsx or .csv.',
      ],
      [],
      [
        'Limits: 5 MB and 5,000 rows per file. Rows with errors show up in the preview and do not stop the rest from importing.',
      ],
      [
        'If you upload the same file twice, repeated transactions are marked as duplicates and not imported.',
      ],
    ],
    demo: [
      ['Groceries', 'expense', 62.4, 'expense'],
      ['November salary', 'income', 1500, 'income'],
      ['Gas', 'expense', 35, null],
      ['Restaurant', 'expense', 28.75, 'expense'],
      ['Electricity', 'expense', 45.1, 'expense'],
      ['Pharmacy', 'expense', 12.99, null],
      ['Internet', 'expense', 30, 'expense'],
      ['Sold used bike', 'income', 120, null],
      ['Movies', 'expense', 9.5, 'expense'],
      ['Coffee', 'expense', 3.25, null],
      ['Purchase refund', 'income', 18.4, 'income'],
      ['Water', 'expense', 15, 'expense'],
      ['Taxi', 'expense', 7.8, null],
      ['Clothes', 'expense', 54, 'expense'],
      ['Savings interest', 'income', 2.35, 'income'],
    ],
  },
};

// Rows of the instructions sheet that are headings (same layout in both languages).
const HELP_BOLD_ROWS = [7, 14];

export const languageOf = (language) => (language === 'es' ? 'es' : 'en');
export const templateFileName = (language, demo) =>
  COPY[languageOf(language)].file(demo);

const pad = (n) => String(n).padStart(2, '0');
const isoDay = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// Excel stores dates as UTC midnight; building them in UTC keeps the day exact.
const excelDate = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};

/**
 * Builds the import template: a data sheet with Excel validation on every
 * column (dropdowns for type and the user's categories), a sheet of
 * instructions, and, for the demo, ~15 sample rows.
 */
export async function buildTemplate({
  language,
  categories,
  demo = false,
  today = new Date(),
}) {
  const lang = languageOf(language);
  const copy = COPY[lang];
  const headers = HEADERS[lang];
  const types = TYPE_LABELS[lang];
  const lastRow = LIMITS.maxRows + 1;
  const maxDate = new Date(
    today.getFullYear() + 1,
    today.getMonth(),
    today.getDate(),
  );

  const book = new ExcelJS.Workbook();
  book.creator = 'Goals App';
  const sheet = book.addWorksheet(copy.dataSheet, {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  const help = book.addWorksheet(copy.helpSheet);
  // Dropdown sources live on a hidden sheet so names with commas still work.
  const lists = book.addWorksheet('lists', { state: 'veryHidden' });

  sheet.columns = [
    {
      header: headers.date,
      key: 'date',
      width: 14,
      style: { numFmt: 'yyyy-mm-dd' },
    },
    { header: headers.description, key: 'description', width: 40 },
    {
      header: headers.amount,
      key: 'amount',
      width: 14,
      style: { numFmt: '0.00' },
    },
    { header: headers.type, key: 'type', width: 12 },
    { header: headers.category, key: 'category', width: 24 },
  ];
  const head = sheet.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF047857' },
  };

  const names = [...new Set(categories.map((c) => c.name))].sort((a, b) =>
    a.localeCompare(b),
  );
  names.forEach((name, i) => {
    lists.getCell(`A${i + 1}`).value = name;
  });

  const rule = (key, extra) => ({
    allowBlank: key === 'category',
    showErrorMessage: true,
    errorStyle: 'stop',
    errorTitle: copy.errors[key][0],
    error: copy.errors[key][1],
    ...extra,
  });
  const validations = {
    A: rule('date', {
      type: 'date',
      operator: 'between',
      formulae: [excelDate(LIMITS.minDate), excelDate(isoDay(maxDate))],
    }),
    B: rule('description', {
      type: 'textLength',
      operator: 'between',
      formulae: [1, LIMITS.maxDescription],
    }),
    C: rule('amount', {
      type: 'decimal',
      operator: 'between',
      formulae: [0.01, LIMITS.maxAmount],
    }),
    D: rule('type', {
      type: 'list',
      formulae: [`"${types.expense},${types.income}"`],
    }),
    E: names.length
      ? rule('category', {
          type: 'list',
          formulae: [`lists!$A$1:$A$${names.length}`],
        })
      : null,
  };
  for (const [col, validation] of Object.entries(validations)) {
    if (validation)
      sheet.dataValidations.add(`${col}2:${col}${lastRow}`, validation);
  }

  if (demo) {
    const byType = {
      expense: names.filter((n) =>
        categories.some((c) => c.name === n && c.type === 'expense'),
      ),
      income: names.filter((n) =>
        categories.some((c) => c.name === n && c.type === 'income'),
      ),
    };
    const used = { expense: 0, income: 0 };
    copy.demo.forEach(([description, type, amount, categoryType], i) => {
      const day = Math.min(i + 1, 28);
      const pool = categoryType ? byType[categoryType] : [];
      // Rotate through the user's own categories so the demo imports as is.
      const category = pool.length
        ? pool[used[categoryType]++ % pool.length]
        : null;
      sheet.addRow({
        date: excelDate(
          `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(day)}`,
        ),
        description,
        amount,
        type: types[type],
        category,
      });
    });
  }

  help.columns = [{ width: 16 }, { width: 12 }, { width: 70 }, { width: 26 }];
  copy.help.forEach((row) => help.addRow(row));
  help.getRow(1).font = { bold: true, size: 14 };
  for (const row of HELP_BOLD_ROWS) help.getRow(row).font = { bold: true };

  return book.xlsx.writeBuffer();
}
