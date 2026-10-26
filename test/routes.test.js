'use strict';
// Real route handlers/middleware, with only Express registration and external I/O
// replaced. This is not an HTTP/browser integration or a live MongoDB test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-route-test-'));
Object.assign(process.env, {
  CHANNEL_POLICY_FILE: path.join(directory, 'policy.json'),
  JWT_SECRET: 'synthetic-test-signing-material-only-000000',
  ADMIN_EMAILS: 'operator@example.invalid',
  APP_ALLOWED_EMAILS: 'member@example.invalid',
  WHATSAPP_ENABLED: 'false', MONGO_URI: '', CLAUDE_API_KEY: '',
  WEBHOOK_SECRET: '', WHAPI_TOKENS_JSON: '{"test-channel":"synthetic-provider-token-do-not-send"}',
});
const networkCalls = [];
global.fetch = async (...args) => { networkCalls.push(args); throw new Error('External network forbidden'); };
const app = { routes: [], middleware: [], disable() {}, use(fn) { this.middleware.push(fn); } };
for (const method of ['get', 'post', 'patch', 'put', 'delete']) app[method] = (route, ...handlers) => app.routes.push({ method, route, handlers });
function express() { return app; }
express.json = express.static = () => (req, res, next) => next();
const originalLoad = Module._load;
Module._load = function(name, ...args) {
  if (name === 'express') return express;
  if (name === 'cors') return () => (req, res, next) => next();
  if (name === 'mongodb') throw new Error('Real database forbidden');
  return originalLoad.call(this, name, ...args);
};
let server;
try {
  const filename = path.resolve(__dirname, '../server.js');
  const source = fs.readFileSync(filename, 'utf8').replace('let policy = null;', "const policy = new (require('./lib/channel-policy').ChannelPolicy)(process.env.CHANNEL_POLICY_FILE);");
  const isolated = new Module(filename, module);
  isolated.filename = filename;
  isolated.paths = Module._nodeModulePaths(path.dirname(filename));
  isolated._compile(source, filename);
  server = isolated.exports;
} finally { Module._load = originalLoad; }
const admin = { email: 'operator@example.invalid', name: 'Synthetic operator', role: 'admin' };
const member = { email: 'member@example.invalid', name: 'Synthetic member', role: 'member' };
server.mem.users.push(admin, member);
async function invoke(method, route, { actor = admin, body = {}, params = {}, query = {}, headers = {} } = {}) {
  const entry = app.routes.find(r => r.method === method && r.route === route);
  assert.ok(entry, route + ' should be registered');
  const req = { body, params, query, headers: { ...(actor ? { authorization: 'Bearer ' + server.makeToken(actor) } : {}), ...headers } };
  const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(value) { this.body = value; this.done = true; return this; }, sendStatus(n) { this.statusCode = n; this.done = true; } };
  for (const handler of entry.handlers) {
    let nextCalled = false, failure;
    await handler(req, res, err => { nextCalled = true; failure = err; });
    if (failure) { const errorHandler = app.middleware.find(fn => fn.length === 4); await errorHandler(failure, req, res, () => {}); break; }
    if (!nextCalled || res.done) break;
  }
  return res;
}
test.after(() => { fs.rmSync(directory, { recursive: true, force: true }); assert.equal(networkCalls.length, 0); });

test('public registration cannot create or bootstrap an administrator', async () => {
  const before = server.mem.users.length;
  const res = await invoke('post', '/api/auth/register', { actor: null, body: { email: 'intruder@example.invalid', password: 'fake', name: 'Synthetic' } });
  assert.equal(res.statusCode, 403); assert.equal(server.mem.users.length, before);
});
test('all channel and group endpoints enforce operator-authorized current admin role', async () => {
  for (const route of app.routes.filter(r => r.route.startsWith('/api/channels'))) {
    for (const actor of [null, member, { ...member, role: 'admin' }, { email: 'untrusted@example.invalid', name: 'Unknown', role: 'admin' }]) {
      const res = await invoke(route.method, route.route, { actor, body: { id: 'not-created' } });
      assert.ok([401, 403].includes(res.statusCode), `${route.method} ${route.route}: ${res.statusCode}`);
    }
  }
  assert.deepEqual(server.policy.list(), []);
});
test('role downgrade takes effect for already issued admin token', async () => {
  const token = server.makeToken(admin);
  admin.role = 'member';
  const res = await invoke('get', '/api/channels', { actor: null, headers: { authorization: 'Bearer ' + token } });
  admin.role = 'admin'; assert.equal(res.statusCode, 403);
});
test('channel API starts paused, rejects browser token fields, and never returns provider secret', async () => {
  let res = await invoke('post', '/api/channels', { body: { id: 'rejected', label: 'Rejected', token: 'synthetic-secret' } });
  assert.equal(res.statusCode, 400);
  res = await invoke('post', '/api/channels', { body: { id: 'test-channel', label: 'Synthetic channel' } });
  assert.equal(res.statusCode, 200); assert.equal(res.body.channel.active, false);
  res = await invoke('get', '/api/channels');
  assert.equal(res.body.length, 1);
  assert.equal(JSON.stringify(res.body).includes('synthetic-provider-token'), false);
  assert.equal(Object.hasOwn(res.body[0], 'token'), false);
  assert.equal(fs.readFileSync(path.join(directory, 'policy.json'), 'utf8').includes('token'), false);
});
test('explicit channel activation rejects legacy toggle and string booleans', async () => {
  const params = { id: 'test-channel' };
  for (const body of [{}, { active: 'true' }]) assert.equal((await invoke('patch', '/api/channels/:id/toggle', { params, body })).statusCode, 400);
  assert.equal(server.policy.get('test-channel').active, false);
  const res = await invoke('patch', '/api/channels/:id/toggle', { params, body: { active: true } });
  assert.equal(res.statusCode, 200); assert.equal(res.body.active, true);
});
test('disconnected server refuses provider group requests and all webhook messages', async () => {
  const before = JSON.stringify(server.mem);
  const sync = await invoke('get', '/api/channels/:id/groups', { params: { id: 'test-channel' } });
  assert.equal(sync.statusCode, 503);
  const web = await invoke('post', '/webhook', { actor: null, query: { channel: 'test-channel' }, body: { messages: [{ chat_id: '120000000001@g.us', text: { body: 'WTS synthetic phone USD 100' } }] } });
  assert.equal(web.statusCode, 503); assert.equal(JSON.stringify(server.mem), before); assert.equal(networkCalls.length, 0);
});
test('delete plus stale browser resync cannot recreate the channel', async () => {
  assert.equal((await invoke('delete', '/api/channels/:id', { params: { id: 'test-channel' } })).statusCode, 200);
  assert.equal((await invoke('post', '/api/channels', { body: { id: 'test-channel', label: 'Stale browser' } })).statusCode, 409);
  assert.deepEqual(server.policy.list(), []);
});
test('health accurately identifies the disconnected mode', async () => {
  const res = await invoke('get', '/health', { actor: null });
  assert.equal(res.body.whatsapp.enabled, false); assert.equal(res.body.whatsapp.configured, false);
});
test('invalid tokens cannot authorize controls', async () => {
  for (const token of ['fake', server.makeToken(admin) + '.extra', Buffer.from(JSON.stringify({ email: admin.email, role: 'admin' })).toString('base64') + '.bad']) {
    assert.equal((await invoke('get', '/api/channels', { actor: null, headers: { authorization: 'Bearer ' + token } })).statusCode, 401);
  }
});

test('production startup rejects missing MongoDB before opening an HTTP listener', async () => {
  await assert.rejects(server.start(), /MongoDB must be configured/);
  assert.equal(networkCalls.length, 0);
});
