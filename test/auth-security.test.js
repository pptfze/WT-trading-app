'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { hashPassword, verifyPassword, parsePasswordHash, validateNewPassword, canonicalEmail, createSessionSigner, validateDatabaseName, parseTrustedProxyCidrs, sessionTTL } = require('../lib/auth-security');
const { MongoLoginLimiter, WINDOW_MS } = require('../lib/login-limiter');
const { accountPlan, applyAccountChange } = require('../lib/operator-accounts');
const { parseArgs, main } = require('../scripts/manage-operator');
const { fixtureMongo } = require('./fake-mongo');
const secret = 'synthetic-test-only-not-a-live-secret-000000000000';
const password = 'Synthetic only password 90210!';
const user = { email: 'owner@example.invalid', name: 'Synthetic Owner', role: 'admin', authVersion: 0 };
let hash;
test.before(async () => { hash = await hashPassword(password); });

test('password hash is versioned salted scrypt with reviewed pinned parameters', async () => {
  const second = await hashPassword(password);
  assert.notEqual(hash, second);
  assert.ok(parsePasswordHash(hash));
  assert.match(hash, /^scrypt\$v1\$65536\$8\$2\$/);
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword(password + 'x', hash), false);
});
test('legacy SHA-256, unknown versions and malformed parameters are never accepted', async () => {
  const legacy = crypto.createHash('sha256').update(password + secret).digest('hex');
  for (const encoded of [legacy, hash.replace('$v1$', '$v2$'), hash.replace('$65536$', '$1$'), hash + '00', undefined]) {
    assert.equal(parsePasswordHash(encoded), null);
    assert.equal(await verifyPassword(password, encoded), false);
  }
});
test('new password policy checks full characters and UTF-8 bytes without truncation', () => {
  for (const value of ['', 'short', ' '.repeat(20), 'a'.repeat(257), '🔒'.repeat(65), null]) assert.throws(() => validateNewPassword(value));
  for (const value of ['a'.repeat(15), 'a'.repeat(256), '🔒'.repeat(15), ' leading spaces are kept ']) assert.doesNotThrow(() => validateNewPassword(value));
});
test('invalid password types and oversize inputs do not reach scrypt', async () => {
  for (const input of [null, {}, [], '', 'x'.repeat(257)]) assert.equal(await verifyPassword(input, hash), false);
});
test('email canonicalization is bounded and rejects query injection', () => {
  assert.equal(canonicalEmail(' Owner@Example.Invalid '), user.email);
  for (const input of [null, {}, { $ne: null }, 'bad', 'a b@example.invalid', 'a@b\n.invalid', 'a'.repeat(260) + '@x.invalid']) assert.equal(canonicalEmail(input), null);
});
test('sessions use v2 format, fresh identifiers, max 8 hours and no stored role claims', () => {
  const signer = createSessionSigner({ secret, now: () => 1800000000000 });
  const account = { ...user, passwordHash: hash };
  const token = signer.issue(account), claim = signer.verify(token);
  assert.ok(token.startsWith('v2.')); assert.equal(claim.exp - claim.iat, 28800);
  assert.equal(Object.hasOwn(claim, 'role'), false); assert.equal(Object.hasOwn(claim, 'name'), false);
  assert.notEqual(token, signer.issue(account)); assert.equal(signer.accountMatches(claim, account), true);
  assert.equal(signer.accountMatches(claim, { ...account, authVersion: 1 }), false);
  assert.equal(signer.accountMatches(claim, { ...account, disabled: true }), false);
  assert.equal(signer.accountMatches(claim, { ...account, passwordHash: hash + 'changed' }), false);
});
test('session expires at its exact deadline and rejects tampering/legacy/unbounded claims', () => {
  let now = 1800000000000;
  const signer = createSessionSigner({ secret, ttlSeconds: 900, now: () => now });
  const token = signer.issue(user), claim = signer.verify(token);
  for (const bad of [null, '', token + '.extra', 'junk', token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a'), Buffer.from(JSON.stringify({ email: user.email, exp: now + 86400000 * 30 })).toString('base64') + '.old']) assert.equal(signer.verify(bad), null);
  const signed = altered => { const p = Buffer.from(JSON.stringify(altered)).toString('base64url'); return 'v2.' + p + '.' + crypto.createHmac('sha256', secret).update('wt.session.v2.' + p).digest('hex'); };
  for (const altered of [{ ...claim, exp: claim.iat + 86400 }, { ...claim, iat: claim.iat + 31, exp: claim.exp + 31 }, { ...claim, av: -1 }, { ...claim, sid: 'bad' }, { ...claim, cv: 'bad' }, { ...claim, v: 1 }]) assert.equal(signer.verify(signed(altered)), null);
  now += 900000; assert.equal(signer.verify(token), null);
});
test('session TTL and missing secret fail closed', () => {
  assert.equal(sessionTTL(undefined), 28800);
  for (const value of ['x', 899, 28801, 0, 1234.5]) assert.throws(() => sessionTTL(value));
  const signer = createSessionSigner({ secret: '' }); assert.equal(signer.verify('fake'), null); assert.throws(() => signer.issue(user));
});
test('database selection is explicit and does not accept URI components', () => {
  assert.equal(validateDatabaseName('wa_trading_staging'), 'wa_trading_staging');
  for (const value of [undefined, '', 'prod/db', 'with space', 'prod.$db', '9db', 'a'.repeat(64)]) assert.throws(() => validateDatabaseName(value));
});
test('proxy trust accepts only explicit IP/CIDRs, rejecting blanket or hop-count trust', () => {
  assert.deepEqual(parseTrustedProxyCidrs(), []);
  assert.deepEqual(parseTrustedProxyCidrs('127.0.0.1/32,::1/128'), ['127.0.0.1/32', '::1/128']);
  for (const value of ['true', '1', '*', 'loopback', '0.0.0.0/0', '::/0', '127.0.0.1/33', '10.0.0.0/', 'host.example.invalid']) assert.throws(() => parseTrustedProxyCidrs(value));
});

async function limiterFixture() {
  const fake = fixtureMongo(); let now = 1800000000000;
  const first = new MongoLoginLimiter(fake.db.collection('limits'), secret, { now: () => now, client: fake.client });
  const second = new MongoLoginLimiter(fake.db.collection('limits'), secret, { now: () => now, client: fake.client });
  await first.initialize(); await second.initialize();
  return { ...fake, first, second, advance: ms => { now += ms; } };
}
test('login account cap is atomic across two instances, including parallel attempts', async () => {
  const f = await limiterFixture();
  const results = await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? f.first : f.second).consume({ email: user.email, ip: '192.0.2.' + i })));
  assert.equal(results.filter(r => r.allowed).length, 10);
  assert.ok(results.filter(r => !r.allowed).every(r => r.retryAfter > 0));
  assert.ok(f.calls.filter(c => c.action === 'findOneAndUpdate').every(c => c.options.session && c.options.includeResultMetadata === false));
});
test('login caps unknown-account spray per peer and global traffic across peers', async () => {
  const f = await limiterFixture();
  for (let i = 0; i < 100; i++) assert.equal((await f.first.consume({ email: `unknown${i}@example.invalid`, ip: '192.0.2.1' })).allowed, true);
  assert.equal((await f.second.consume({ email: 'another@example.invalid', ip: '192.0.2.1' })).allowed, false);
  for (let i = 100; i < 300; i++) assert.equal((await f.first.consume({ email: `unknown${i}@example.invalid`, ip: `192.0.2.${i}` })).allowed, true);
  assert.equal((await f.second.consume({ email: 'last@example.invalid', ip: '198.51.100.1' })).allowed, false);
});
test('already limited traffic cannot exhaust global quota or retain new peer records', async () => {
  const f = await limiterFixture();
  for (let i = 0; i < 10; i++) await f.first.consume({ email: user.email, ip: '192.0.2.1' });
  const before = JSON.stringify(f.state.get('limits'));
  for (let i = 0; i < 310; i++) assert.equal((await f.second.consume({ email: user.email, ip: `198.51.100.${i}` })).allowed, false);
  assert.equal(JSON.stringify(f.state.get('limits')), before);
  assert.equal((await f.first.consume({ email: 'other@example.invalid', ip: '203.0.113.1' })).allowed, true);
  const transactions = f.calls.filter(c => c.action === 'transaction');
  assert.ok(transactions.every(c => c.options.timeoutMS === 5000 && c.options.writeConcern.w === 'majority'));
  assert.equal(f.calls.filter(c => c.action === 'endSession').length, transactions.length);
});
test('transaction errors roll back counter writes and end the session without granting login', async () => {
  const f = await limiterFixture();
  const collection = f.db.collection('limits'), real = collection.findOneAndUpdate;
  let operations = 0;
  collection.findOneAndUpdate = async (...args) => { if (++operations === 2) throw Error('Synthetic transaction outage'); return real(...args); };
  const limiter = new MongoLoginLimiter(collection, secret, { client: f.client }); await limiter.initialize();
  await assert.rejects(limiter.consume({ email: user.email, ip: '192.0.2.1' }));
  assert.equal(f.state.get('limits').length, 0);
  assert.equal(f.calls.filter(c => c.action === 'endSession').length, 1);
});
test('rate limits survive instance replacement, reset by window, and do not rely on TTL deletion', async () => {
  const f = await limiterFixture();
  for (let i = 0; i < 10; i++) await f.first.consume({ email: user.email, ip: '192.0.2.1' });
  assert.equal((await f.second.consume({ email: user.email, ip: '192.0.2.1' })).allowed, false);
  const before = f.state.get('limits').length; f.advance(WINDOW_MS);
  assert.equal((await f.second.consume({ email: user.email, ip: '192.0.2.1' })).allowed, true);
  assert.ok(f.state.get('limits').length > before);
  assert.ok(f.calls.some(c => c.action === 'index' && c.options.expireAfterSeconds === 0));
});
test('limiter stores only HMAC identifiers, expiration and bounded counters', async () => {
  const f = await limiterFixture(); await f.first.consume({ email: user.email, ip: '192.0.2.1' });
  const stored = JSON.stringify(f.state.get('limits'));
  assert.equal(stored.includes(user.email), false); assert.equal(stored.includes('192.0.2.1'), false);
  for (const row of f.state.get('limits')) assert.deepEqual(Object.keys(row).sort(), ['_id', 'attempts', 'expiresAt']);
});
test('limiter fails closed without initialization, on outage or malformed database result', async () => {
  const f = await limiterFixture(); const limiter = new MongoLoginLimiter(f.db.collection('limits'), secret);
  await assert.rejects(limiter.consume({}), /unavailable/);
  for (const method of ['updateOne', 'findOneAndUpdate']) {
    const collection = f.db.collection('limits'); collection[method] = async () => { throw Error('Synthetic outage'); };
    const broken = new MongoLoginLimiter(collection, secret, { client: f.client }); await broken.initialize();
    await assert.rejects(broken.consume({ email: user.email, ip: '192.0.2.1' }));
  }
  const collection = f.db.collection('limits'); collection.findOneAndUpdate = async () => ({ _id: 'wrong', attempts: 1 });
  const corrupt = new MongoLoginLimiter(collection, secret, { client: f.client }); await corrupt.initialize(); await assert.rejects(corrupt.consume({}), /unavailable/);
});
test('operator plan cannot bootstrap outsiders or escalate a member to administrator', () => {
  const env = { ADMIN_EMAILS: user.email, APP_ALLOWED_EMAILS: 'member@example.invalid' };
  assert.equal(accountPlan({ action: 'create', email: user.email, name: user.name, role: 'admin' }, env).role, 'admin');
  for (const input of [
    { action: 'create', email: 'outsider@example.invalid', name: 'Outsider', role: 'admin' },
    { action: 'create', email: 'member@example.invalid', name: 'Member', role: 'admin' },
    { action: 'create', email: user.email, name: 'Owner', role: 'root' },
    { action: 'reset-password', email: user.email, role: 'admin' },
    { action: 'unknown', email: user.email }
  ]) assert.throws(() => accountPlan(input, env));
});
test('operator utility writes only current hashes; reset/disable/revoke invalidate sessions', async () => {
  const f = fixtureMongo(), collection = f.db.collection('users');
  await applyAccountChange(collection, { action: 'create', ...user }, hash);
  let account = await collection.findOne({ email: user.email });
  assert.equal(account.passwordHash, hash); assert.equal(account.authVersion, 0); assert.equal(account.disabled, false);
  await assert.rejects(applyAccountChange(collection, { action: 'reset-password', email: user.email }, 'legacy-sha'));
  for (const action of ['reset-password', 'disable', 'enable', 'revoke-sessions']) await applyAccountChange(collection, { action, email: user.email }, hash);
  account = await collection.findOne({ email: user.email }); assert.equal(account.authVersion, 4); assert.equal(account.disabled, false);
  await assert.rejects(applyAccountChange(collection, { action: 'disable', email: 'missing@example.invalid' }), /not found/);
});
test('operator CLI rejects password arguments, duplicate switches and implicit writes', async () => {
  for (const args of [['create', '--password', 'secret'], ['create', '--email', 'x', '--email', 'y'], ['create', '--apply', '--apply']]) assert.throws(() => parseArgs(args));
  await assert.rejects(main(['create', '--email', user.email, '--database', 'synthetic_test']), /Maintenance blocked/);
});
