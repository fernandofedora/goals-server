import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { Category, Transaction } from '../models/index.js';

const router = express.Router();
router.use(authMiddleware);

const plain = (item) => {
  const data = item.toJSON();
  delete data.UserId;
  return data;
};

const parseBudget = (monthlyBudget) =>
  monthlyBudget !== undefined && monthlyBudget !== '' && monthlyBudget !== null
    ? Number(monthlyBudget)
    : null;

// Subcategories are one level deep: the parent must be the user's own
// top-level category, and the child takes the parent's type.
async function resolveParent(userId, parentId, selfId) {
  if (parentId === undefined || parentId === null || parentId === '') {
    return { parent: null };
  }
  if (Number(parentId) === Number(selfId)) {
    return {
      error: 'CATEGORY_INVALID_PARENT',
      message: 'Una categoría no puede ser su propia subcategoría.',
    };
  }
  const parent = await Category.findOne({
    where: { id: parentId, UserId: userId },
  });
  if (!parent) {
    return { error: 'CATEGORY_INVALID_PARENT', message: 'Not found' };
  }
  if (parent.parentId) {
    return {
      error: 'CATEGORY_TOO_DEEP',
      message: 'Solo se permite un nivel de subcategorías.',
    };
  }
  return { parent };
}

router.get('/', async (req, res) => {
  const items = await Category.findAll({
    where: { UserId: req.userId },
    attributes: { exclude: ['UserId'] },
  });
  res.json(items);
});

router.post('/', async (req, res) => {
  const { name, color, type, monthlyBudget, parentId } = req.body;
  const { parent, error, message } = await resolveParent(req.userId, parentId);
  if (error) return res.status(400).json({ code: error, message });
  const item = await Category.create({
    name,
    color,
    type: parent ? parent.type : type,
    monthlyBudget: parseBudget(monthlyBudget),
    parentId: parent?.id ?? null,
    UserId: req.userId,
  });
  res.json(plain(item));
});

router.put('/:id', async (req, res) => {
  const item = await Category.findOne({
    where: { id: req.params.id, UserId: req.userId },
  });
  if (!item) return res.status(404).json({ message: 'Not found' });
  const { name, color, type, monthlyBudget } = req.body;
  const fields = {
    name,
    color,
    type,
    monthlyBudget: parseBudget(monthlyBudget),
  };

  // parentId is only touched when sent, so older clients keep working.
  const movesParent = Object.prototype.hasOwnProperty.call(
    req.body,
    'parentId',
  );
  const targetParentId = movesParent ? req.body.parentId : item.parentId;
  const { parent, error, message } = await resolveParent(
    req.userId,
    targetParentId,
    item.id,
  );
  if (error) return res.status(400).json({ code: error, message });

  const childCount = await Category.count({ where: { parentId: item.id } });
  if (parent && childCount > 0) {
    return res.status(400).json({
      code: 'CATEGORY_TOO_DEEP',
      message: 'Una categoría con subcategorías no puede ser subcategoría.',
    });
  }
  if (parent) fields.type = parent.type;
  fields.parentId = parent?.id ?? null;

  await item.update(fields);
  // Children always share their parent's type.
  if (childCount > 0) {
    await Category.update(
      { type: item.type },
      { where: { parentId: item.id, UserId: req.userId } },
    );
  }
  res.json(plain(item));
});

router.delete('/:id', async (req, res) => {
  const item = await Category.findOne({
    where: { id: req.params.id, UserId: req.userId },
  });
  if (!item) return res.status(404).json({ message: 'Not found' });
  if (await Category.count({ where: { parentId: item.id } })) {
    return res.status(409).json({
      code: 'CATEGORY_HAS_CHILDREN',
      message: 'Mueve o borra primero sus subcategorías.',
    });
  }
  if (await Transaction.count({ where: { CategoryId: item.id } })) {
    return res.status(409).json({
      code: 'CATEGORY_IN_USE',
      message: 'No se puede eliminar: la categoría se usa en transacciones',
    });
  }
  await item.destroy();
  res.json({ success: true });
});

export default router;
