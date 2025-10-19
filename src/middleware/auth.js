import jwt from 'jsonwebtoken';

export const authMiddleware = (req, res, next) => {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ message: 'No token' });
  const token = header.replace('Bearer ', '');
  try {
    const payload = jwt.verify(token, process.env.SECRET_KEY);
    req.userId = payload.id;
    next();
  } catch (e) { return res.status(401).json({ message: 'Invalid token' }); }
};