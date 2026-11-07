'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { isIP } = require('node:net');
const scrypt = promisify(crypto.scrypt);

// OWASP's 64 MiB scrypt profile. Pin each format version to reviewed parameters:
// never accept an arbitrary cost from a database record or request.
const SCRYPT = Object.freeze({ N: 65536, r: 8, p: 2, maxmem: 80 * 1024 * 1024 });
const PASSWORD_MAX_BYTES = 256;
const SESSION_MAX_SECONDS = 8 * 60 * 60;
const DUMMY_SALT = Buffer.alloc(16, 0x53);
const DUMMY_HASH = Buffer.alloc(64);
let activeHashes = 0;

function securityError(message, status = 503) {
  return Object.assign(new Error(message), { status });
}
function canonicalEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@\x00-\x1f]+@[^\s@\x00-\x1f]+\.[^\s@\x00-\x1f]+$/.test(email)) return null;
  return email;
}
function passwordInputValid(value) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= PASSWORD_MAX_BYTES;
}
function validateNewPassword(password) {
  if (!passwordInputValid(password) || [...password].length < 15 || !password.trim()) {
    throw securityError('Use a password of at least 15 characters and at most 256 UTF-8 bytes.', 400);
  }
}
async function derive(password, salt) {
  // Bound per-process RAM and worker-pool load; do not keep an unbounded queue.
  if (activeHashes >= 2) throw securityError('Authentication is busy; try again shortly.');
  activeHashes++;
  try { return await scrypt(password, salt, 64, SCRYPT); }
  finally { activeHashes--; }
}
function parsePasswordHash(encoded) {
  if (typeof encoded !== 'string') return null;
  const match = /^scrypt\$v1\$65536\$8\$2\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(encoded);
  return match ? { salt: Buffer.from(match[1], 'hex'), hash: Buffer.from(match[2], 'hex') } : null;
}
async function hashPassword(password) {
  validateNewPassword(password);
  const salt = crypto.randomBytes(16);
  const hash = await derive(password, salt);
  return `scrypt$v1$65536$8$2$${salt.toString('hex')}$${hash.toString('hex')}`;
}
async function verifyPassword(password, encoded) {
  if (!passwordInputValid(password)) return false;
  const parsed = parsePasswordHash(encoded);
  // Missing accounts, legacy SHA-256 and malformed records follow the same slow
  // path. None is accepted or silently migrated, even with a matching password.
  const actual = await derive(password, parsed?.salt || DUMMY_SALT);
  const equal = crypto.timingSafeEqual(actual, parsed?.hash || DUMMY_HASH);
  return parsed !== null && equal;
}
function authVersion(user) {
  if (user.authVersion === undefined) return 0;
  return Number.isSafeInteger(user.authVersion) && user.authVersion >= 0 ? user.authVersion : null;
}
function credentialVersion(user) {
  return crypto.createHash('sha256').update(typeof user.passwordHash === 'string' ? user.passwordHash : '').digest('hex');
}
function sessionTTL(value) {
  if (value === undefined || value === '') return SESSION_MAX_SECONDS;
  const ttl = Number(value);
  if (!Number.isSafeInteger(ttl) || ttl < 900 || ttl > SESSION_MAX_SECONDS) throw securityError('AUTH_SESSION_TTL_SECONDS must be an integer from 900 to 28800.');
  return ttl;
}
function createSessionSigner({ secret, ttlSeconds = SESSION_MAX_SECONDS, now = Date.now }) {
  const ready = typeof secret === 'string' && Buffer.byteLength(secret) >= 32;
  const ttl = sessionTTL(ttlSeconds);
  const signature = payload => crypto.createHmac('sha256', secret).update('wt.session.v2.' + payload).digest('hex');
  function issue(user) {
    if (!ready) throw securityError('Authentication is not configured');
    const email = canonicalEmail(user.email), av = authVersion(user);
    if (!email || email !== user.email || av === null || user.disabled === true) throw securityError('Invalid account state');
    const iat = Math.floor(now() / 1000);
    const claims = { v: 2, email, iat, exp: iat + ttl, av, cv: credentialVersion(user), sid: crypto.randomBytes(16).toString('hex') };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `v2.${payload}.${signature(payload)}`;
  }
  function verify(token) {
    try {
      if (!ready || typeof token !== 'string' || token.length > 2048) return null;
      const parts = token.split('.');
      if (parts.length !== 3 || parts[0] !== 'v2' || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[a-f0-9]{64}$/.test(parts[2])) return null;
      const [, payload, sig] = parts;
      if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(signature(payload), 'hex'))) return null;
      const claim = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      const current = Math.floor(now() / 1000);
      if (claim.v !== 2 || canonicalEmail(claim.email) !== claim.email || !claim.email ||
          !Number.isSafeInteger(claim.iat) || !Number.isSafeInteger(claim.exp) || claim.iat < 0 ||
          claim.iat > current + 30 || claim.exp <= current || claim.exp <= claim.iat || claim.exp - claim.iat > ttl ||
          !Number.isSafeInteger(claim.av) || claim.av < 0 || !/^[a-f0-9]{64}$/.test(claim.cv) || !/^[a-f0-9]{32}$/.test(claim.sid)) return null;
      return claim;
    } catch { return null; }
  }
  function accountMatches(claim, user) {
    return !!claim && !!user && user.disabled !== true && user.email === claim.email &&
      authVersion(user) === claim.av && credentialVersion(user) === claim.cv;
  }
  return { ready, issue, verify, accountMatches, ttlSeconds: ttl };
}

function validateDatabaseName(value) {
  // Deliberately narrower than MongoDB's full naming grammar. No implicit
  // database selection from URI paths or fallback to the legacy database.
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,62}$/.test(value)) {
    throw securityError('Set an explicit MONGODB_DB_NAME using 1–63 letters, digits, underscores or hyphens, starting with a letter.');
  }
  return value;
}
function parseTrustedProxyCidrs(value = '') {
  if (!value) return [];
  if (typeof value !== 'string') throw securityError('TRUST_PROXY_CIDRS must be explicit IP addresses or CIDRs.');
  const entries = value.split(',').map(x => x.trim());
  if (entries.length > 16 || entries.some(entry => {
    const parts = entry.split('/'), version = isIP(parts[0]);
    return !version || parts.length > 2 || (parts.length === 2 && (!/^\d+$/.test(parts[1]) || Number(parts[1]) < 1 || Number(parts[1]) > (version === 4 ? 32 : 128)));
  })) throw securityError('TRUST_PROXY_CIDRS must contain narrow explicit IP addresses or CIDRs; wildcard/hop-count trust is not supported.');
  return entries;
}

module.exports = { SCRYPT, PASSWORD_MAX_BYTES, SESSION_MAX_SECONDS, canonicalEmail, validateNewPassword, parsePasswordHash, hashPassword, verifyPassword, authVersion, credentialVersion, createSessionSigner, sessionTTL, validateDatabaseName, parseTrustedProxyCidrs, securityError };
