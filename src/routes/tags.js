import express from 'express';
import { col, fn } from 'sequelize';
import { authMiddleware } from '../middleware/auth.js';
import { Tag, TransactionTag } from '../models/index.js';
import { normalizeText } from '../utils/categoryRules.js';

const router = express.Router();
router.use(authMiddleware);

const MAX_TAGS_PER_USER = 100;
const HEX = /^#[0-9a-f]{6}$/i;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * Checks a tag from the request body. Commas are refused because exports join
 * a transaction's tags with them. `selfId` skips the tag itself on rename.
 */
async function validateTag(userId, body, selfId = null) {
  const name = String(body.name ?? '')
    .replace(CONTROL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name || name.length > 40 || name.includes(',')) {
    return {
      error: 'TAG_INVALID_NAME',
      message: 'El nombre debe tener entre 1 y 40 caracteres, sin comas.',
    };
  }
  if (body.color !== undefined && !HEX.test(String(body.color))) {
    return { error: 'TAG_INVALID_COLOR', message: 'Color no válido.' };
  }
  const existing = await Tag.findAll({
    where: { UserId: userId },
    attributes: ['id', 'name'],
  });
  if (
    existing.some(
      (t) => t.id !== selfId && normalizeText(t.name) === normalizeText(name),
    )
  ) {
    return {
      error: 'TAG_DUPLICATE',
      message: 'Ya tienes una etiqueta con ese nombre.',
    };
  }
  return {
    fields: { name, ...(body.color ? { color: body.color } : {}) },
    count: existing.length,
  };
}

const fail = (res, { error, message }) =>
  res.status(400).json({ code: error, message });
const plain = (tag) => ({ id: tag.id, name: tag.name, color: tag.color });

// Tags with how many transactions use each one, alphabetically.
router.get('/', async (req, res) => {
  const tags = await Tag.findAll({
    where: { UserId: req.userId },
    order: [['name', 'ASC']],
  });
  const counts = tags.length
    ? await TransactionTag.findAll({
        attributes: ['TagId', [fn('COUNT', col('TransactionId')), 'count']],
        where: { TagId: tags.map((t) => t.id) },
        group: ['TagId'],
        raw: true,
      })
    : [];
  const countOf = new Map(counts.map((c) => [c.TagId, Number(c.count)]));
  res.json(tags.map((t) => ({ ...plain(t), count: countOf.get(t.id) || 0 })));
});

router.post('/', async (req, res) => {
  const checked = await validateTag(req.userId, req.body);
  if (checked.error) return fail(res, checked);
  if (checked.count >= MAX_TAGS_PER_USER) {
    return res
      .status(400)
      .json({ code: 'TAG_LIMIT', message: 'Llegaste al máximo de etiquetas.' });
  }
  const tag = await Tag.create({ ...checked.fields, UserId: req.userId });
  res.json({ ...plain(tag), count: 0 });
});

const findTag = (userId, id) =>
  /^\d+$/.test(String(id))
    ? Tag.findOne({ where: { id, UserId: userId } })
    : null;

router.put('/:id', async (req, res) => {
  const tag = await findTag(req.userId, req.params.id);
  if (!tag) return res.status(404).json({ message: 'Not found' });
  const checked = await validateTag(
    req.userId,
    { name: tag.name, ...req.body },
    tag.id,
  );
  if (checked.error) return fail(res, checked);
  await tag.update(checked.fields);
  res.json(plain(tag));
});

// Deleting a tag only removes it from its transactions; they stay as they are.
router.delete('/:id', async (req, res) => {
  const tag = await findTag(req.userId, req.params.id);
  if (!tag) return res.status(404).json({ message: 'Not found' });
  await TransactionTag.destroy({ where: { TagId: tag.id } });
  await tag.destroy();
  res.json({ success: true });
});

export default router;
