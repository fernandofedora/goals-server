import jwt from 'jsonwebtoken';
import { User } from '../models/index.js';

export const authMiddleware = (req, res, next) => {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ message: 'No token' });
  const token = header.replace('Bearer ', '');
  try {
    const payload = jwt.verify(token, process.env.SECRET_KEY);
    req.userId = payload.id;
    req.isSuperAdmin = payload.isSuperAdmin || false;
    next();
  } catch (e) { return res.status(401).json({ message: 'Invalid token' }); }
};

// Double-check against DB – never trust only the token for privileged operations
export const superAdminMiddleware = async (req, res, next) => {
  try {
    const user = await User.findByPk(req.userId);
    if (!user || !user.isSuperAdmin || !user.isActive) {
      return res.status(403).json({ message: 'Super Admin access required' });
    }
    next();
  } catch (e) {
    return res.status(500).json({ message: 'Server error' });
  }
};