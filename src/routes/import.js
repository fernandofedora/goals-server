import express from 'express';
import multer from 'multer';
import { authMiddleware } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { Category, User } from '../models/index.js';
import { buildTemplate, templateFileName } from '../utils/importTemplate.js';
import { MAX_FILE_BYTES, readImportFile } from '../utils/importFile.js';
import {
  buildPreview,
  commitImport,
  listBatches,
  resolveTarget,
  undoBatch,
} from '../services/importService.js';

const router = express.Router();
router.use(authMiddleware);

// GET /api/import/template?demo=1 — the empty template, or the example with
// sample rows, in the user's language and with their categories as a dropdown.
router.get(
  '/template',
  rateLimit((req) => `import-template:${req.userId}`, { limit: 30 }),
  async (req, res) => {
    try {
      const user = await User.findByPk(req.userId, { attributes: ['language'] });
      const categories = await Category.findAll({
        where: { UserId: req.userId },
        attributes: ['name', 'type'],
      });
      const demo = req.query.demo === '1';
      const buffer = await buildTemplate({ language: user?.language, categories, demo });
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${templateFileName(user?.language, demo)}"`,
      );
      res.send(Buffer.from(buffer));
    } catch (e) {
      console.error(e);
      res.status(500).json({ message: 'Server error' });
    }
  },
);

// Uploads stay in memory (never on disk) and are cut off past 5 MB.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 4, fieldSize: 64 * 1024, parts: 6 },
}).single('file');

const FILE_STATUS = { FILE_TOO_LARGE: 413, FILE_TOO_MANY_ROWS: 413 };
const fileError = (res, code) =>
  res.status(FILE_STATUS[code] || 400).json({ code, message: 'Archivo no válido' });

const receiveFile = (req, res, next) =>
  upload(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return fileError(res, 'FILE_TOO_LARGE');
    return fileError(res, 'FILE_INVALID_UPLOAD');
  });

// Reads and checks the upload, then builds the preview. Shared by preview and
// commit: commit never trusts the rows a client sends back, it reads the file again.
async function readAndPreview(req, res) {
  const target = await resolveTarget(req.userId, req.body?.target);
  if (!target) {
    res.status(400).json({ code: 'TARGET_INVALID', message: 'Cuenta o tarjeta no válida' });
    return null;
  }
  const parsed = await readImportFile(req.file);
  if (parsed.error) {
    fileError(res, parsed.error);
    return null;
  }
  const user = await User.findByPk(req.userId, { attributes: ['language'] });
  const preview = await buildPreview(req.userId, user?.language, target, parsed.rows);
  return { target, preview };
}

router.post(
  '/preview',
  rateLimit((req) => `import-preview:${req.userId}`, { limit: 30 }),
  receiveFile,
  async (req, res) => {
    try {
      const result = await readAndPreview(req, res);
      if (result) res.json(result.preview);
    } catch (e) {
      console.error(e);
      res.status(500).json({ message: 'Server error' });
    }
  },
);

router.post(
  '/commit',
  rateLimit((req) => `import-commit:${req.userId}`, { limit: 10 }),
  receiveFile,
  async (req, res) => {
    try {
      let include = null;
      if (req.body?.include !== undefined) {
        try {
          include = JSON.parse(req.body.include);
        } catch {
          include = 'bad';
        }
        const valid =
          Array.isArray(include) &&
          include.length <= 5000 &&
          include.every((n) => Number.isInteger(n) && n > 1);
        if (!valid) return res.status(400).json({ code: 'INCLUDE_INVALID', message: 'Selección no válida' });
      }
      const result = await readAndPreview(req, res);
      if (!result) return;
      res.json({
        ...(await commitImport(req.userId, result.target, result.preview, include)),
        summary: result.preview.summary,
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ message: 'Server error' });
    }
  },
);

router.get('/batches', async (req, res) => {
  res.json(await listBatches(req.userId));
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.delete('/batches/:batchId', async (req, res) => {
  if (!UUID.test(req.params.batchId)) return res.status(404).json({ message: 'Not found' });
  const deleted = await undoBatch(req.userId, req.params.batchId);
  if (!deleted) return res.status(404).json({ message: 'Not found' });
  res.json({ deleted });
});

export default router;
