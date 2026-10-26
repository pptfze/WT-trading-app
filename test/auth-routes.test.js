'use strict';
// Real route/middleware functions in a VM, with fake Express and synthetic DB.
// No HTTP listener, external request, real account or driver is used here.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const { fixtureMongo } = require('./fake-mongo');
const { hashPassword } = require('../lib/auth-security');
const root = path.resolve(__dirname, '..'), file = path.join(root, 'server.js'), localRequire = createRequire(file);
const password = 'Synthetic only correct password 90210';
let hash;
test.before(async () => { hash = await hashPassword(password); });

async function fixture({ storageReady = true } = {}) {
  const fake = fixtureMongo();
  const admin = { email: 'owner@example.invalid', name: 'Synthetic Owner', role: 'admin', authVersion: 0, passwordHash: hash };
  const member = { email: 'member@example.invalid', name: 'Synthetic Member', role: 'member', authVersion: 0, passwordHash: hash };
  const app = { routes: [], middleware: [], disable() {}, set() {}, use(fn) { this.middleware.push(fn); } };
  for (const method of ['get', 'post', 'patch', 'put', 'delete']) app[method] = (route, ...handlers) => app.routes.push({ method, route, handlers });
  function express() { return app; } express.json = express.static = () => () => {};
  const context = { module: { exports: {} }, Buffer, Date, AbortSignal, __dirname: root, console: { log() {}, error() {} }, process: { env: {
    JWT_SECRET: 'synthetic-test-signing-material-only-000000000000', ADMIN_EMAILS: admin.email, APP_ALLOWED_EMAILS: member.email, WHATSAPP_ENABLED: 'false', MONGODB_DB_NAME: 'synthetic_test', AI_ENABLED: 'false'
  } }, require(name) {
    if (name === 'express') return express; if (name === 'cors') return () => () => {};
    if (name === 'mongodb') throw Error('Live database forbidden'); return localRequire(name);
  }, setInterval() { throw Error('No listeners or schedulers'); }, clearInterval() {}, async fetch() { throw Error('No external calls'); } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(file, 'utf8') + '\nmodule.exports.__install = async (d, c, ready) => { db = d; if (ready) { loginLimiter = new MongoLoginLimiter(d.collection("auth_login_limits_v1"), JWT_SECRET, { client: c }); await loginLimiter.initialize(); } };', context, { filename: file });
  const server = context.module.exports; await server.__install(fake.db, fake.client, storageReady);
  await fake.db.collection('users').insertMany([admin, member]);
  async function call(method, route, { body = {}, actor = null, token, headers = {}, ip = '192.0.2.1' } = {}) {
    const entry = app.routes.find(r => r.method === method && r.route === route); assert.ok(entry, route);
    const req = { body, query: {}, params: {}, ip, headers: { ...(token ? { authorization: 'Bearer ' + token } : actor ? { authorization: 'Bearer ' + server.makeToken(actor) } : {}), ...headers } };
    const res = { statusCode: 200, headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(n) { this.statusCode = n; return this; }, json(value) { this.body = value; this.done = true; return this; } };
    for (const fn of entry.handlers) {
      let next = false, error; await fn(req, res, e => { next = true; error = e; });
      if (error) { await app.middleware.find(f => f.length === 4)(error, req, res, () => {}); break; }
      if (!next || res.done) break;
    }
    return res;
  }
  return { ...fake, server, admin, member, call };
}

test('login normalizes an allowed email and returns bounded session, no password material', async () => {
  const f = await fixture();
  const login = await f.call('post', '/api/auth/login', { body: { email: ' Owner@Example.Invalid ', password } });
  assert.equal(login.statusCode, 200); assert.equal(login.body.expiresIn, 28800);
  assert.equal(login.headers['Cache-Control'], 'no-store'); assert.equal(login.body.user.email, f.admin.email);
  assert.equal(JSON.stringify(login.body).includes(hash), false); assert.equal(JSON.stringify(login.body).includes(password), false);
  assert.equal((await f.call('get', '/api/auth/me', { token: login.body.token })).statusCode, 200);
});
test('incorrect, unknown, disallowed, legacy and disabled credentials receive generic rejection', async () => {
  const f = await fixture();
  await f.db.collection('users').insertOne({ email: 'outsider@example.invalid', passwordHash: hash, role: 'admin' });
  for (const body of [
    { email: f.admin.email, password: password + 'wrong' },
    { email: 'missing@example.invalid', password },
    { email: 'outsider@example.invalid', password },
    { email: { $ne: null }, password },
    { email: f.admin.email, password: { $ne: null } }
  ]) { const result = await f.call('post', '/api/auth/login', { body }); assert.equal(result.statusCode, 401); assert.equal(result.body.error, 'Invalid credentials'); }
  await f.db.collection('users').updateOne({ email: f.admin.email }, { $set: { disabled: true } });
  assert.equal((await f.call('post', '/api/auth/login', { body: { email: f.admin.email, password } })).statusCode, 401);
  await f.db.collection('users').updateOne({ email: f.admin.email }, { $set: { disabled: false, passwordHash: localRequire('node:crypto').createHash('sha256').update(password + contextSecret()).digest('hex') } });
  assert.equal((await f.call('post', '/api/auth/login', { body: { email: f.admin.email, password } })).statusCode, 401);
});
function contextSecret() { return 'synthetic-test-signing-material-only-000000000000'; }
test('public registration stays disabled even when no owner exists', async () => {
  const f = await fixture(); f.state.set('users', []);
  const result = await f.call('post', '/api/auth/register', { body: { email: f.admin.email, password, role: 'admin' } });
  assert.equal(result.statusCode, 403); assert.equal(f.state.get('users').length, 0);
});
test('login blocks without durable initialized rate-limit storage before account lookup', async () => {
  const f = await fixture({ storageReady: false });
  const result = await f.call('post', '/api/auth/login', { body: { email: f.admin.email, password } });
  assert.equal(result.statusCode, 503); assert.equal(f.calls.some(c => c.action === 'findOne' && c.name === 'users'), false);
});
test('rate limit applies to all attempts, returns Retry-After, and ignores spoofed forwarded headers', async () => {
  const f = await fixture();
  // Invalid passwords are quick but must still consume account quota.
  for (let i = 0; i < 10; i++) assert.equal((await f.call('post', '/api/auth/login', { body: { email: f.admin.email, password: {} }, headers: { 'x-forwarded-for': `192.0.2.${i}` } })).statusCode, 401);
  const result = await f.call('post', '/api/auth/login', { body: { email: f.admin.email, password }, headers: { 'x-forwarded-for': '198.51.100.100' } });
  assert.equal(result.statusCode, 429); assert.ok(Number(result.headers['Retry-After']) > 0);
});
test('logout revokes the authenticated account across all already-issued tokens', async () => {
  const f = await fixture(); const first = f.server.makeToken(f.admin), second = f.server.makeToken(f.admin);
  assert.equal((await f.call('post', '/api/auth/logout', { token: first })).statusCode, 200);
  for (const token of [first, second]) assert.equal((await f.call('get', '/api/auth/me', { token })).statusCode, 401);
  assert.equal((await f.call('get', '/api/auth/me', { actor: f.member })).statusCode, 200);
  const login = await f.call('post', '/api/auth/login', { body: { email: f.admin.email, password } });
  assert.equal(login.statusCode, 200); assert.equal((await f.call('get', '/api/auth/me', { token: login.body.token })).statusCode, 200);
});
test('password reset and disable invalidate tokens; current role always comes from DB', async () => {
  const f = await fixture(); const token = f.server.makeToken(f.admin);
  await f.db.collection('users').updateOne({ email: f.admin.email }, { $set: { role: 'member' } });
  const me = await f.call('get', '/api/auth/me', { token }); assert.equal(me.body.role, 'member');
  assert.equal((await f.call('get', '/api/channels', { token })).statusCode, 403);
  await f.db.collection('users').updateOne({ email: f.admin.email }, { $set: { disabled: true } });
  assert.equal((await f.call('get', '/api/auth/me', { token })).statusCode, 401);
  await f.db.collection('users').updateOne({ email: f.admin.email }, { $set: { disabled: false, passwordHash: hash + 'changed' } });
  assert.equal((await f.call('get', '/api/auth/me', { token })).statusCode, 401);
  assert.ok(f.calls.filter(c => c.action === 'findOne' && c.name === 'users').every(c => c.options.readPreference === 'primary' && c.options.readConcern.level === 'linearizable'));
});
test('unauthenticated, legacy and malformed sessions cannot revoke accounts', async () => {
  const f = await fixture();
  for (const token of [undefined, 'old.token', 'v2.bad.bad']) assert.equal((await f.call('post', '/api/auth/logout', { token })).statusCode, 401);
  assert.equal((await f.db.collection('users').findOne({ email: f.admin.email })).authVersion, 0);
});
test('account store read outage cannot authenticate or confirm logout', async () => {
  const f = await fixture();
  f.server.DB.getUser = async () => { throw Error('Synthetic storage outage'); };
  assert.equal((await f.call('post', '/api/auth/login', { body: { email: f.admin.email, password } })).statusCode, 503);
  assert.equal((await f.call('post', '/api/auth/logout', { actor: f.admin })).statusCode, 503);
});
