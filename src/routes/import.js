import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { Category, User } from '../models/index.js';
import { buildTemplate, templateFileName } from '../utils/importTemplate.js';

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

export default router;
