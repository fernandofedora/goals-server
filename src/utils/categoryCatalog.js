import { Category } from '../models/index.js';

// Suggested categories: [type, color, es, en, children as [es, en]].
const CATALOG = [
  [
    'expense',
    '#0f766e',
    'Hogar',
    'Home',
    [
      ['Alquiler o hipoteca', 'Rent or mortgage'],
      ['Luz', 'Electricity'],
      ['Agua', 'Water'],
      ['Internet y teléfono', 'Internet and phone'],
      ['Mantenimiento', 'Maintenance'],
    ],
  ],
  [
    'expense',
    '#f59e0b',
    'Comida',
    'Food',
    [
      ['Supermercado', 'Groceries'],
      ['Restaurantes', 'Restaurants'],
      ['Delivery', 'Delivery'],
    ],
  ],
  [
    'expense',
    '#3b82f6',
    'Transporte',
    'Transportation',
    [
      ['Combustible', 'Fuel'],
      ['Transporte público', 'Public transport'],
      ['Taxi y apps', 'Taxi and ride apps'],
      ['Mantenimiento del vehículo', 'Vehicle maintenance'],
    ],
  ],
  [
    'expense',
    '#e11d48',
    'Salud',
    'Health',
    [
      ['Consultas', 'Doctor visits'],
      ['Farmacia', 'Pharmacy'],
      ['Seguro médico', 'Health insurance'],
    ],
  ],
  [
    'expense',
    '#7c3aed',
    'Educación',
    'Education',
    [
      ['Colegiatura', 'Tuition'],
      ['Cursos', 'Courses'],
      ['Libros y materiales', 'Books and supplies'],
    ],
  ],
  [
    'expense',
    '#ec4899',
    'Entretenimiento',
    'Entertainment',
    [
      ['Salidas', 'Going out'],
      ['Streaming y suscripciones', 'Streaming and subscriptions'],
      ['Viajes', 'Travel'],
    ],
  ],
  [
    'expense',
    '#0891b2',
    'Compras personales',
    'Personal shopping',
    [
      ['Ropa', 'Clothing'],
      ['Cuidado personal', 'Personal care'],
      ['Tecnología', 'Technology'],
    ],
  ],
  [
    'expense',
    '#ea580c',
    'Familia y mascotas',
    'Family and pets',
    [
      ['Hijos', 'Children'],
      ['Mascotas', 'Pets'],
      ['Regalos', 'Gifts'],
    ],
  ],
  [
    'expense',
    '#b91c1c',
    'Deudas y comisiones',
    'Debt and fees',
    [
      ['Intereses de tarjeta', 'Card interest'],
      ['Comisiones bancarias', 'Bank fees'],
      ['Cuotas de préstamos', 'Loan payments'],
    ],
  ],
  ['expense', '#475569', 'Impuestos y trámites', 'Taxes and paperwork', []],
  ['expense', '#db2777', 'Donaciones', 'Donations', []],
  ['expense', '#6b7280', 'Otros gastos', 'Other expenses', []],
  ['income', '#059669', 'Salario', 'Salary', []],
  ['income', '#16a34a', 'Trabajo independiente', 'Freelance work', []],
  ['income', '#0d9488', 'Negocio', 'Business', []],
  [
    'income',
    '#65a30d',
    'Inversiones',
    'Investments',
    [
      ['Intereses', 'Interest'],
      ['Dividendos', 'Dividends'],
    ],
  ],
  ['income', '#22c55e', 'Regalos recibidos', 'Gifts received', []],
  ['income', '#10b981', 'Reembolsos', 'Refunds', []],
  ['income', '#4d7c0f', 'Otros ingresos', 'Other income', []],
  ['transfer', '#64748b', 'Entre mis cuentas', 'Between my accounts', []],
  ['transfer', '#334155', 'Pago de tarjeta', 'Card payment', []],
  ['transfer', '#0e7490', 'A mi cuenta de ahorro', 'To my savings account', []],
];

const key = (name) => name.trim().toLocaleLowerCase();

/**
 * Adds the suggested categories the user is missing, in their language.
 * Matches by name (case-insensitive) and type; never edits or deletes anything.
 * Returns how many categories were created.
 */
export async function addSuggestedCategories(userId, language) {
  const lang = language === 'es' ? 0 : 1;
  const existing = await Category.findAll({ where: { UserId: userId } });
  const find = (name, type, parentId) =>
    existing.find(
      (c) =>
        key(c.name) === key(name) &&
        c.type === type &&
        (parentId === undefined || (c.parentId ?? null) === parentId),
    );

  let created = 0;
  for (const [type, color, es, en, children] of CATALOG) {
    const name = lang === 0 ? es : en;
    // A same-named category the user already has keeps its place, even nested.
    let parent = find(name, type);
    if (!parent) {
      parent = await Category.create({ name, type, color, UserId: userId });
      existing.push(parent);
      created += 1;
    }
    // Subcategories only hang from a top-level category (one level deep).
    if (parent.parentId) continue;
    for (const pair of children) {
      const childName = pair[lang];
      if (find(childName, type, parent.id)) continue;
      const child = await Category.create({
        name: childName,
        type,
        color,
        parentId: parent.id,
        UserId: userId,
      });
      existing.push(child);
      created += 1;
    }
  }
  return created;
}
