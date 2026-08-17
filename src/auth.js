import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { query, withTransaction } from './db.js';

const TOKEN_TTL = '7d';

export async function register({ email, password, name, role, vehicle, plate }) {
  if (!email || !password || !name) throw new AuthError(400, 'email, password and name are required');
  if (password.length < 6) throw new AuthError(400, 'password must be at least 6 characters');
  if (!['rider', 'driver'].includes(role)) throw new AuthError(400, "role must be 'rider' or 'driver'");

  const passwordHash = await bcrypt.hash(password, 10);

  return withTransaction(async (client) => {
    let user;
    try {
      const { rows } = await client.query(
        `INSERT INTO users (email, password_hash, name, role)
         VALUES ($1, $2, $3, $4) RETURNING id, email, name, role`,
        [email.toLowerCase().trim(), passwordHash, name, role]
      );
      user = rows[0];
    } catch (err) {
      if (err.code === '23505') throw new AuthError(409, 'email already registered');
      throw err;
    }

    let driverId = null;
    if (role === 'driver') {
      const { rows } = await client.query(
        `INSERT INTO drivers (user_id, vehicle, plate) VALUES ($1, $2, $3) RETURNING id`,
        [user.id, vehicle || 'Sedan', plate || plateFrom(user.id)]
      );
      driverId = rows[0].id;
    }

    return { user, driverId, token: issueToken(user, driverId) };
  });
}

export async function login({ email, password }) {
  const { rows } = await query(
    `SELECT u.id, u.email, u.name, u.role, u.password_hash, d.id AS driver_id
       FROM users u LEFT JOIN drivers d ON d.user_id = u.id
      WHERE u.email = $1`,
    [String(email || '').toLowerCase().trim()]
  );
  const row = rows[0];
  if (!row || !(await bcrypt.compare(String(password || ''), row.password_hash))) {
    throw new AuthError(401, 'invalid credentials');
  }

  const user = { id: row.id, email: row.email, name: row.name, role: row.role };
  return { user, driverId: row.driver_id, token: issueToken(user, row.driver_id) };
}

export function issueToken(user, driverId) {
  return jwt.sign(
    { sub: user.id, email: user.email, name: user.name, role: user.role, driverId: driverId || null },
    config.jwtSecret,
    { expiresIn: TOKEN_TTL }
  );
}

export function verifyToken(token) {
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    return {
      userId: payload.sub,
      email: payload.email,
      name: payload.name,
      role: payload.role,
      driverId: payload.driverId,
    };
  } catch {
    return null;
  }
}

/** Express middleware: requires a valid `Authorization: Bearer <token>`. */
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const user = token && verifyToken(token);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  req.user = user;
  next();
}

/** Express middleware: requires the caller to be a driver. */
export function requireDriver(req, res, next) {
  if (req.user?.role !== 'driver' || !req.user.driverId) {
    return res.status(403).json({ error: 'driver account required' });
  }
  next();
}

export class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const plateFrom = (id) => `SIM-${id.slice(0, 4).toUpperCase()}`;
