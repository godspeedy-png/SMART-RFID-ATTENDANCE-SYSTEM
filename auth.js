const crypto = require('crypto');
const db = require('./db');

const SESSION_MS = 8 * 60 * 60 * 1000;   // stay logged in for 8 hours
const sessions = new Map();               // token -> { username, expires }
const attempts = new Map();               // ip -> { count, until }

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function getSession(req) {
  const token = parseCookies(req.headers.cookie).session;
  const s = token && sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return s;
}

// Runs before protected routes: no valid session means no entry
function requireAdmin(req, res, next) {
  if (!getSession(req)) {
    return res.status(401).json({ error: 'Please log in' });
  }
  next();
}

function login(req, res) {
  const ip = req.ip;
  let a = attempts.get(ip);
  if (a && a.until && a.until <= Date.now()) {
    attempts.delete(ip);
    a = undefined;
  }
  if (a && a.until > Date.now()) {
    return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  }

  const username = String(req.body.username || '');
  const password = String(req.body.password || '');

  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  let ok = false;
  if (admin) {
    const given = Buffer.from(hashPassword(password, admin.salt), 'hex');
    const real = Buffer.from(admin.hash, 'hex');
    ok = given.length === real.length && crypto.timingSafeEqual(given, real);
  }

  if (!ok) {
    const count = (a ? a.count : 0) + 1;
    attempts.set(ip, { count: count, until: count >= 5 ? Date.now() + 15 * 60 * 1000 : 0 });
    return res.status(401).json({ error: 'Wrong username or password' });
  }

  attempts.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { username: admin.username, expires: Date.now() + SESSION_MS });
  res.setHeader('Set-Cookie',
    'session=' + token + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + (SESSION_MS / 1000));
  res.json({ ok: true, username: admin.username });
}

function logout(req, res) {
  const token = parseCookies(req.headers.cookie).session;
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
}

function me(req, res) {
  const s = getSession(req);
  res.json({ loggedIn: !!s, username: s ? s.username : null });
}

module.exports = { hashPassword, requireAdmin, login, logout, me };