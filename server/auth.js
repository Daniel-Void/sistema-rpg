const crypto = require('node:crypto');

const COOKIE_NAME = 'rpg_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 dias

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function createSessions(secret) {
  const sign = (data) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

  function createToken(userId) {
    const payload = Buffer.from(JSON.stringify({ uid: userId, exp: Date.now() + SESSION_TTL_MS })).toString('base64url');
    return `${payload}.${sign(payload)}`;
  }

  function verifyToken(token) {
    if (typeof token !== 'string') return null;
    const [payload, signature] = token.split('.');
    if (!payload || !signature) return null;
    const expected = Buffer.from(sign(payload));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
      if (typeof data.uid !== 'number' || data.exp < Date.now()) return null;
      return data.uid;
    } catch {
      return null;
    }
  }

  return { createToken, verifyToken };
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (key) cookies[key] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return cookies;
}

function sessionCookie(token, { secure }) {
  const attrs = [`${COOKIE_NAME}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${SESSION_TTL_MS / 1000}`];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

function clearedCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

module.exports = { COOKIE_NAME, hashPassword, verifyPassword, createSessions, parseCookies, sessionCookie, clearedCookie };
