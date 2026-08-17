import { Router } from 'express';
import { register, login, requireAuth, AuthError } from '../auth.js';

export const authRoutes = Router();

authRoutes.post('/register', async (req, res, next) => {
  try {
    res.status(201).json(await register(req.body || {}));
  } catch (err) {
    next(err instanceof AuthError ? err : err);
  }
});

authRoutes.post('/login', async (req, res, next) => {
  try {
    res.json(await login(req.body || {}));
  } catch (err) {
    next(err);
  }
});

authRoutes.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});
