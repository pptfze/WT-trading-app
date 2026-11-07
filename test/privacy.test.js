'use strict';

// Offline behavioral tests of the shared policy rules and production ingestion.
// The filesystem policy/lock is a test reference, not production storage.
// Do not require server.js:
// that file owns HTTP/provider/database initialization. Every record is synthetic.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let networkAttempts = 0;
const originalFetch = global.fetch;
global.fetch = () => {
  networkAttempts++;
  throw new Error('Network is forbidden in privacy tests');
};
test.after(() => {
  global.fetch = originalFetch;
  assert.equal(networkAttempts, 0, 'The privacy suite must never attempt network access');
});

const { ChannelPolicy, channelIdValid, groupIdValid } = require('../lib/channel-policy');
const { createIngestor } = require('../lib/ingestion');
const { acquirePolicyLock } = require('../lib/policy-lock');

const CHANNEL = 'synthetic-channel';
const GROUP_ON = '100001@g.us';
const GROUP_OFF = '100002-100003@g.us';
const GROUP_NEW = '100004@g.us';
const TRADE = 'WTS synthetic handset 256GB USD 500 brand new';
const CLASSIFICATION = { type: 'WTS', condition: 'Brand New', model: 'Synthetic handset', price: 500, currency: 'USD' };
const COUNTER_NAMES = ['storage', 'raw', 'classify', 'score', 'db', 'trader', 'alerts', 'country'];

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-privacy-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'channel-policy.json');
  if (Object.hasOwn(options, 'contents')) fs.writeFileSync(filename, options.contents);
  const policy = new ChannelPolicy(filename, options.io || fs);
  return { directory, filename, policy };
}

function configured(t, options = {}) {
  const result = fixture(t, options);
  result.policy.create(CHANNEL, 'Synthetic test channel');
  sync(result.policy, [{ id: GROUP_ON, name: 'Synthetic selected group' }, { id: GROUP_OFF, name: 'Synthetic OFF group' }]);
  result.policy.setGroups(CHANNEL, [{ id: GROUP_ON, enabled: true }]);
  result.policy.setActive(CHANNEL, true);
  return result;
}

function sync(policy, groups, channel = CHANNEL) {
  return policy.mergeGroups(channel, groups, policy.get(channel).generation);
}

function message(overrides = {}) {
  return { chat_id: GROUP_ON, is_group: true, from_me: false, from: 'synthetic-sender@s.whatsapp.net', timestamp: 1700000000, text: { body: TRADE }, ...overrides };
}

function unreadableMessage(overrides = {}) {
  const item = message(overrides);
  for (const key of ['text', 'caption', 'from', 'timestamp']) {
    Object.defineProperty(item, key, { get() { throw new Error(`Rejected message ${key} was accessed`); } });
  }
  return item;
}

function harness(policy, overrides = {}) {
  const calls = Object.fromEntries(COUNTER_NAMES.map(name => [name, []]));
  const wrap = (name, fallback) => (...args) => {
    calls[name].push(args);
    return (overrides[name] || fallback)(...args);
  };
  const ingest = createIngestor({
    policy,
    ready: overrides.ready || (() => true),
    storageReady: wrap('storage', async () => true),
    recordRaw: wrap('raw', () => {}),
    classify: wrap('classify', async () => ({ ...CLASSIFICATION })),
    score: wrap('score', async () => ({ dealScore: 7, isFlagged: false })),
    insert: wrap('db', async () => {}),
    recordTrader: wrap('trader', () => {}),
    checkAlerts: wrap('alerts', async () => {}),
    phoneToCountry: wrap('country', () => 'Synthetic country'),
  });
  return { ingest, calls };
}

function expectCounts(calls, expected = {}) {
  for (const name of COUNTER_NAMES) assert.equal(calls[name].length, expected[name] || 0, `${name} call count`);
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function status(expected) {
  return error => error instanceof Error && error.status === expected;
}

test('JID validation admits only exact, bounded WhatsApp group identifiers', () => {
  for (const gid of [GROUP_ON, GROUP_OFF, '1@g.us']) assert.equal(groupIdValid(gid), true, gid);
  for (const gid of [undefined, null, 7, {}, [], '', '100001', '100001@s.whatsapp.net', '100001@c.us', '100001@lid', 'status@broadcast', '100001@broadcast', '100001@newsletter', 'abc@g.us', '-1@g.us', '1-2-3@g.us', '1@g.us.evil', '1@g.us ', ' 1@g.us', '1@G.US', '1@g.us\n', '1@g.us\r', '1@g.us\0', '1'.repeat(130) + '@g.us']) {
    assert.equal(groupIdValid(gid), false, String(gid));
  }
  for (const id of [CHANNEL, 'x', 'Synthetic_01']) assert.equal(channelIdValid(id), true);
  for (const id of [null, {}, [], '', '../channel', '/etc/passwd', '__proto__', 'x\n', 'x'.repeat(129)]) assert.equal(channelIdValid(id), false, String(id));
});

test('a new policy and a newly created channel default to deny, even after sync', async t => {
  const { policy } = fixture(t);
  assert.equal(policy.ready, true);
  assert.deepEqual(policy.list(), []);
  assert.equal(policy.allows(CHANNEL, GROUP_ON), false);
  const created = policy.create(CHANNEL);
  assert.equal(created.active, false);
  assert.deepEqual(created.groups, {});
  sync(policy, [{ id: GROUP_ON, name: 'Synthetic provider group', enabled: true }]);
  assert.equal(policy.get(CHANNEL).groups[GROUP_ON].enabled, false);
  assert.equal(policy.allows(CHANNEL, GROUP_ON), false);
  const { ingest, calls } = harness(policy);
  assert.deepEqual(await ingest(CHANNEL, [unreadableMessage()]), { accepted: 0, ignored: 1 });
  expectCounts(calls);
});

test('unknown, missing, malformed and inherited-property channel names are blocked before reading content', async t => {
  const { policy } = configured(t);
  const { ingest, calls } = harness(policy);
  for (const channel of ['unknown-channel', '', undefined, null, [], {}, '../synthetic-channel', 'constructor', 'toString', '__proto__']) {
    assert.deepEqual(await ingest(channel, [unreadableMessage()]), { accepted: 0, ignored: 1 });
  }
  expectCounts(calls);
});

test('unknown channel lookup does not inherit Object.prototype members', t => {
  const { policy } = configured(t);
  for (const id of ['constructor', 'toString', 'valueOf', '__proto__', 'does-not-exist']) assert.equal(policy.get(id), null);
});

test('personal, broadcast/status, newsletter, malformed and absent JIDs never read message data or reach any sink', async t => {
  const { policy } = configured(t);
  const { ingest, calls } = harness(policy);
  const ids = [undefined, null, 12, {}, [], '', 'synthetic@s.whatsapp.net', '123456@c.us', '123456@lid', 'status@broadcast', '123456@broadcast', '123456@newsletter', 'abc@g.us', GROUP_ON + '.evil', GROUP_ON + '\n', GROUP_ON + ' ', '100001@G.US'];
  for (const chat_id of ids) assert.deepEqual(await ingest(CHANNEL, [unreadableMessage({ chat_id })]), { accepted: 0, ignored: 1 });
  for (const invalid of [null, undefined, 1, 'message', [], true]) assert.deepEqual(await ingest(CHANNEL, [invalid]), { accepted: 0, ignored: 1 });
  expectCounts(calls);
});

test('explicit conflicting or nonboolean group flags are rejected before text/AI/DB', async t => {
  const { policy } = configured(t);
  const { ingest, calls } = harness(policy);
  for (const is_group of [false, 'true', 'false', 1, 0, null, undefined, {}, []]) {
    assert.deepEqual(await ingest(CHANNEL, [unreadableMessage({ is_group })]), { accepted: 0, ignored: 1 });
  }
  for (const chat_type of ['personal', 'broadcast', 'newsletter', 'GROUP', '', null, undefined, true, {}]) {
    assert.deepEqual(await ingest(CHANNEL, [unreadableMessage({ chat_type })]), { accepted: 0, ignored: 1 });
  }
  assert.deepEqual(await ingest(CHANNEL, [unreadableMessage({ from_me: true })]), { accepted: 0, ignored: 1 });
  expectCounts(calls);
});

test('an unselected group and a newly discovered group remain blocked on an active channel', async t => {
  const { policy } = configured(t);
  sync(policy, [{ id: GROUP_NEW, name: 'Synthetic newly discovered group', enabled: true }]);
  const { ingest, calls } = harness(policy);
  for (const chat_id of [GROUP_OFF, GROUP_NEW, '999999@g.us']) assert.deepEqual(await ingest(CHANNEL, [unreadableMessage({ chat_id })]), { accepted: 0, ignored: 1 });
  assert.equal(policy.get(CHANNEL).groups[GROUP_NEW].enabled, false);
  expectCounts(calls);
});

test('one explicitly selected group passes through the real ingestion pipeline exactly once', async t => {
  const { policy } = configured(t);
  const { ingest, calls } = harness(policy);
  assert.deepEqual(await ingest(CHANNEL, [message()]), { accepted: 1, ignored: 0 });
  expectCounts(calls, Object.fromEntries(COUNTER_NAMES.map(name => [name, 1])));
  const raw = calls.raw[0][0];
  const listing = calls.db[0][0];
  assert.equal(raw.text, TRADE);
  assert.equal(raw.channelId, CHANNEL);
  assert.equal(raw.group, GROUP_ON);
  assert.equal(raw.groupName, 'Synthetic selected group');
  assert.equal(listing.raw, TRADE);
  assert.equal(listing.channelId, CHANNEL);
  assert.equal(listing.group, GROUP_ON);
  assert.equal(listing.sender, 'synthetic-sender');
  assert.equal(listing.dealScore, 7);
  assert.deepEqual(calls.classify[0], [TRADE, 'synthetic-sender']);
});

test('a mixed message batch processes only the explicitly allowed member', async t => {
  const { policy } = configured(t);
  const { ingest, calls } = harness(policy);
  const batch = [
    unreadableMessage({ chat_id: GROUP_OFF }),
    unreadableMessage({ chat_id: '123456@s.whatsapp.net' }),
    unreadableMessage({ chat_id: 'status@broadcast' }),
    unreadableMessage({ chat_id: GROUP_NEW }),
    unreadableMessage({ chat_id: GROUP_ON + '\n' }),
    unreadableMessage({ is_group: false }), null, message(),
  ];
  assert.deepEqual(await ingest(CHANNEL, batch), { accepted: 1, ignored: batch.length - 1 });
  expectCounts(calls, Object.fromEntries(COUNTER_NAMES.map(name => [name, 1])));
  assert.equal(calls.raw[0][0].group, GROUP_ON);
  assert.equal(calls.db[0][0].group, GROUP_ON);
});

test('non-array input and empty batches have no effects', async t => {
  const { policy } = configured(t);
  const { ingest, calls } = harness(policy);
  for (const input of [undefined, null, {}, 'messages', 17, []]) assert.deepEqual(await ingest(CHANNEL, input), { accepted: 0, ignored: 0 });
  expectCounts(calls);
});

test('restart preserves explicit ON/OFF group selections and paused channel state', async t => {
  const { policy, filename } = configured(t);
  let restarted = new ChannelPolicy(filename);
  assert.equal(restarted.ready, true);
  assert.equal(restarted.allows(CHANNEL, GROUP_ON), true);
  assert.equal(restarted.allows(CHANNEL, GROUP_OFF), false);
  policy.setActive(CHANNEL, false);
  restarted = new ChannelPolicy(filename);
  assert.equal(restarted.get(CHANNEL).active, false);
  assert.equal(restarted.get(CHANNEL).groups[GROUP_ON].enabled, true);
  assert.equal(restarted.get(CHANNEL).groups[GROUP_OFF].enabled, false);
  const blocked = harness(restarted);
  assert.deepEqual(await blocked.ingest(CHANNEL, [unreadableMessage()]), { accepted: 0, ignored: 1 });
  expectCounts(blocked.calls);
});

test('pause and resume retain choices but do not ingest while paused', async t => {
  const { policy } = configured(t);
  policy.setActive(CHANNEL, false);
  const paused = harness(policy);
  assert.deepEqual(await paused.ingest(CHANNEL, [unreadableMessage()]), { accepted: 0, ignored: 1 });
  expectCounts(paused.calls);
  policy.setActive(CHANNEL, true);
  assert.equal(policy.get(CHANNEL).groups[GROUP_OFF].enabled, false);
  const resumed = harness(policy);
  assert.deepEqual(await resumed.ingest(CHANNEL, [message()]), { accepted: 1, ignored: 0 });
  expectCounts(resumed.calls, Object.fromEntries(COUNTER_NAMES.map(name => [name, 1])));
});

test('group sync cannot overwrite saved ON/OFF, activate a channel, or trust provider enabled flags', t => {
  const { policy, filename } = configured(t);
  policy.setActive(CHANNEL, false);
  sync(policy, [
    { id: GROUP_ON, name: 'Renamed selected group', enabled: false, participants: 14 },
    { id: GROUP_OFF, name: 'Renamed disabled group', enabled: true, participants: 20 },
    { id: GROUP_NEW, name: 'New provider group', enabled: true },
    { id: '123456@s.whatsapp.net', enabled: true },
    { id: 'status@broadcast', enabled: true },
    { id: GROUP_ON + '\n', enabled: true },
    null, 4, [],
  ]);
  sync(policy, []);
  const current = new ChannelPolicy(filename).get(CHANNEL);
  assert.equal(current.active, false);
  assert.equal(current.groups[GROUP_ON].enabled, true);
  assert.equal(current.groups[GROUP_OFF].enabled, false);
  assert.equal(current.groups[GROUP_NEW].enabled, false);
  assert.equal(current.groups[GROUP_ON].name, 'Renamed selected group');
  assert.equal(current.groups[GROUP_ON].participants, 14);
  assert.deepEqual(Object.keys(current.groups).sort(), [GROUP_ON, GROUP_OFF, GROUP_NEW].sort());
});

test('delete persists a tombstone and rejects delayed sync, recreation, restart and webhook resurrection', async t => {
  const { policy, filename } = configured(t);
  const generation = policy.get(CHANNEL).generation;
  policy.remove(CHANNEL);
  assert.equal(policy.get(CHANNEL), null);
  assert.equal(policy.allows(CHANNEL, GROUP_ON), false);
  assert.throws(() => policy.mergeGroups(CHANNEL, [{ id: GROUP_ON, enabled: true }], generation), status(404));
  assert.throws(() => policy.create(CHANNEL), status(409));
  const restarted = new ChannelPolicy(filename);
  assert.equal(restarted.ready, true);
  assert.equal(restarted.get(CHANNEL), null);
  assert.throws(() => restarted.create(CHANNEL), status(409));
  assert.throws(() => restarted.mergeGroups(CHANNEL, [{ id: GROUP_ON }], generation), status(404));
  assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).deleted[CHANNEL], true);
  const { ingest, calls } = harness(restarted);
  assert.deepEqual(await ingest(CHANNEL, [unreadableMessage()]), { accepted: 0, ignored: 1 });
  expectCounts(calls);
});

test('stale sync generation cannot alter any group choice', t => {
  const { policy, filename } = configured(t);
  const before = fs.readFileSync(filename, 'utf8');
  assert.throws(() => policy.mergeGroups(CHANNEL, [{ id: GROUP_NEW }], 'stale-generation'), status(409));
  assert.equal(fs.readFileSync(filename, 'utf8'), before);
  assert.equal(policy.allows(CHANNEL, GROUP_ON), true);
  assert.equal(policy.get(CHANNEL).groups[GROUP_NEW], undefined);
});

test('channel and group selection controls accept only actual booleans, atomically', t => {
  const { policy, filename } = configured(t);
  const before = fs.readFileSync(filename, 'utf8');
  for (const invalid of ['true', 'false', 1, 0, null, undefined, [], {}, new Boolean(true)]) {
    assert.throws(() => policy.setActive(CHANNEL, invalid), status(400));
    assert.throws(() => policy.setGroups(CHANNEL, [{ id: GROUP_OFF, enabled: invalid }]), status(400));
    assert.equal(fs.readFileSync(filename, 'utf8'), before);
  }
  assert.throws(() => policy.setGroups(CHANNEL, [{ id: GROUP_OFF, enabled: true }, { id: GROUP_NEW, enabled: true }]), status(404));
  assert.equal(policy.get(CHANNEL).groups[GROUP_OFF].enabled, false);
  assert.equal(fs.readFileSync(filename, 'utf8'), before);
  policy.setGroups(CHANNEL, [{ id: GROUP_ON, enabled: false }, { id: GROUP_OFF, enabled: true }]);
  assert.equal(policy.allows(CHANNEL, GROUP_ON), false);
  assert.equal(policy.allows(CHANNEL, GROUP_OFF), true);
});

test('returned objects cannot mutate in-memory or persisted channel selections', t => {
  const { policy, filename } = configured(t);
  const before = fs.readFileSync(filename, 'utf8');
  const got = policy.get(CHANNEL);
  got.active = false;
  got.groups[GROUP_OFF].enabled = true;
  const listed = policy.list();
  listed[0].groups[GROUP_ON].enabled = false;
  assert.equal(policy.allows(CHANNEL, GROUP_ON), true);
  assert.equal(policy.allows(CHANNEL, GROUP_OFF), false);
  assert.equal(fs.readFileSync(filename, 'utf8'), before);
});

test('policy storage is created with private file permissions', t => {
  const { filename, directory } = configured(t);
  assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
  assert.equal(fs.statSync(directory).mode & 0o077, 0);
  assert.deepEqual(fs.readdirSync(directory), ['channel-policy.json']);
});

test('corrupt or malformed saved policies fail closed and are never silently replaced', async t => {
  const valid = { version: 1, channels: { [CHANNEL]: { id: CHANNEL, label: 'Synthetic', active: true, generation: 'synthetic-generation', authorizationVersion: 0, groups: { [GROUP_ON]: { id: GROUP_ON, name: 'Synthetic', enabled: true } } } }, deleted: {} };
  // Validate the unmodified baseline so each corruption exercises its own field.
  const baseline = fixture(t, { contents: JSON.stringify(valid) });
  assert.equal(baseline.policy.ready, true);
  assert.equal(baseline.policy.allows(CHANNEL, GROUP_ON), true);
  const corruptions = [
    '{invalid JSON', '', 'null', '[]', '{}',
    JSON.stringify({ ...valid, version: 2 }),
    JSON.stringify({ ...valid, channels: [] }),
    JSON.stringify({ ...valid, deleted: [] }),
    JSON.stringify({ ...valid, deleted: { [CHANNEL]: true } }),
    JSON.stringify({ ...valid, deleted: { removed: 'true' } }),
  ];
  for (const change of [
    state => { state.channels[CHANNEL].active = 'true'; },
    state => { state.channels[CHANNEL].groups[GROUP_ON].enabled = 'true'; },
    state => { state.channels[CHANNEL].groups[GROUP_ON].id = '123456@s.whatsapp.net'; },
    state => { state.channels[CHANNEL].id = 'different-channel'; },
    state => { delete state.channels[CHANNEL].generation; },
    state => { delete state.channels[CHANNEL].authorizationVersion; },
    state => { state.channels[CHANNEL].authorizationVersion = -1; },
    state => { state.channels[CHANNEL].authorizationVersion = '0'; },
    state => { state.channels[CHANNEL].authorizationVersion = Number.MAX_SAFE_INTEGER + 1; },
    state => { state.unexpected = true; },
    state => { state.channels[CHANNEL].unexpected = true; },
    state => { state.channels[CHANNEL].groups[GROUP_ON].unexpected = true; },
    state => { state.channels[CHANNEL].groups['123456@s.whatsapp.net'] = { id: '123456@s.whatsapp.net', name: 'Personal', enabled: true }; },
  ]) {
    const state = structuredClone(valid);
    change(state);
    corruptions.push(JSON.stringify(state));
  }
  for (const contents of corruptions) {
    const { policy, filename } = fixture(t, { contents });
    assert.equal(policy.ready, false, contents);
    assert.equal(policy.allows(CHANNEL, GROUP_ON), false);
    assert.throws(() => policy.list(), status(503));
    assert.throws(() => policy.create('new-channel'), status(503));
    assert.equal(fs.readFileSync(filename, 'utf8'), contents);
    const { ingest, calls } = harness(policy);
    assert.deepEqual(await ingest(CHANNEL, [unreadableMessage()]), { accepted: 0, ignored: 1 });
    expectCounts(calls);
  }
});

test('policy read and initial write failures fail closed without touching content or AI', async t => {
  const cases = [
    { existsSync: () => true, readFileSync: () => { throw Object.assign(new Error('Synthetic permission denial'), { code: 'EACCES' }); } },
    { mkdirSync: () => { throw new Error('Synthetic unavailable directory'); } },
    { openSync: () => { throw new Error('Synthetic unavailable disk'); } },
  ];
  for (const fault of cases) {
    const { policy } = fixture(t, { io: { ...fs, ...fault } });
    assert.equal(policy.ready, false);
    const { ingest, calls } = harness(policy);
    assert.deepEqual(await ingest(CHANNEL, [unreadableMessage()]), { accepted: 0, ignored: 1 });
    expectCounts(calls);
  }
});

test('failed policy mutations block all subsequent ingestion and do not overwrite last durable policy', async t => {
  for (const operation of ['writeFileSync', 'fsyncSync', 'renameSync']) {
    let fail = false;
    const io = { ...fs, [operation]: (...args) => { if (fail) throw new Error(`Synthetic ${operation} failure`); return fs[operation](...args); } };
    const { policy, filename, directory } = configured(t, { io });
    const before = fs.readFileSync(filename, 'utf8');
    fail = true;
    assert.throws(() => policy.setGroups(CHANNEL, [{ id: GROUP_OFF, enabled: true }]), status(503));
    assert.equal(policy.ready, false);
    assert.equal(policy.allows(CHANNEL, GROUP_ON), false);
    assert.equal(fs.readFileSync(filename, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(directory), ['channel-policy.json']);
    const { ingest, calls } = harness(policy);
    assert.deepEqual(await ingest(CHANNEL, [unreadableMessage()]), { accepted: 0, ignored: 1 });
    expectCounts(calls);
    assert.throws(() => policy.setActive(CHANNEL, true), status(503));
  }
});

test('runtime not-ready blocks before storage checks, message access and all sinks', async t => {
  const { policy } = configured(t);
  const { ingest, calls } = harness(policy, { ready: () => false });
  assert.deepEqual(await ingest(CHANNEL, [unreadableMessage()]), { accepted: 0, ignored: 1 });
  expectCounts(calls);
});

test('storage readiness false or error blocks before reading any content or calling any sink', async t => {
  const { policy } = configured(t);
  const unavailable = harness(policy, { storage: async () => false });
  assert.deepEqual(await unavailable.ingest(CHANNEL, [unreadableMessage()]), { accepted: 0, ignored: 1 });
  expectCounts(unavailable.calls, { storage: 1 });
  const failed = harness(policy, { storage: async () => { throw new Error('Synthetic database offline'); } });
  await assert.rejects(failed.ingest(CHANNEL, [unreadableMessage()]), /Synthetic database offline/);
  expectCounts(failed.calls, { storage: 1 });
});

for (const revocation of ['pause', 'group-off', 'delete', 'runtime-unavailable']) {
  test(`revocation during storage readiness (${revocation}) prevents even content access`, async t => {
    const { policy } = configured(t);
    const entered = deferred();
    const release = deferred();
    let ready = true;
    const { ingest, calls } = harness(policy, { ready: () => ready, storage: async () => { entered.resolve(); return release.promise; } });
    const pending = ingest(CHANNEL, [unreadableMessage()]);
    await entered.promise;
    if (revocation === 'pause') policy.setActive(CHANNEL, false);
    if (revocation === 'group-off') policy.setGroups(CHANNEL, [{ id: GROUP_ON, enabled: false }]);
    if (revocation === 'delete') policy.remove(CHANNEL);
    if (revocation === 'runtime-unavailable') ready = false;
    release.resolve(true);
    assert.deepEqual(await pending, { accepted: 0, ignored: 1 });
    expectCounts(calls, { storage: 1 });
  });
}

for (const revocation of ['pause', 'group-off', 'delete', 'runtime-unavailable', 'pause-resume', 'group-off-on']) {
  test(`revocation during classification (${revocation}) prevents later AI, DB, trader and alerts`, async t => {
    const { policy } = configured(t);
    const entered = deferred();
    const release = deferred();
    let ready = true;
    const { ingest, calls } = harness(policy, { ready: () => ready, classify: async () => { entered.resolve(); return release.promise; } });
    const pending = ingest(CHANNEL, [message()]);
    await entered.promise;
    if (revocation.startsWith('pause')) policy.setActive(CHANNEL, false);
    if (revocation.startsWith('group-off')) policy.setGroups(CHANNEL, [{ id: GROUP_ON, enabled: false }]);
    if (revocation === 'delete') policy.remove(CHANNEL);
    if (revocation === 'runtime-unavailable') ready = false;
    if (revocation === 'pause-resume') policy.setActive(CHANNEL, true);
    if (revocation === 'group-off-on') policy.setGroups(CHANNEL, [{ id: GROUP_ON, enabled: true }]);
    release.resolve({ ...CLASSIFICATION });
    assert.deepEqual(await pending, { accepted: 0, ignored: 1 });
    // Raw/classification occurred while permitted; no later side effects may occur.
    expectCounts(calls, { storage: 1, raw: 1, classify: 1 });
  });
}

test('revocation during scoring invalidates the score guard and prevents DB/trader/alerts', async t => {
  const { policy } = configured(t);
  const entered = deferred();
  const release = deferred();
  let guard;
  const { ingest, calls } = harness(policy, { score: async (listing, allowed) => { guard = allowed; entered.resolve(); return release.promise; } });
  const pending = ingest(CHANNEL, [message()]);
  await entered.promise;
  assert.equal(await guard(), true);
  policy.setGroups(CHANNEL, [{ id: GROUP_ON, enabled: false }]);
  assert.equal(await guard(), false);
  release.resolve({ dealScore: 9 });
  assert.deepEqual(await pending, { accepted: 0, ignored: 1 });
  expectCounts(calls, { storage: 1, raw: 1, classify: 1, score: 1, country: 1 });
});

test('revocation after an authorized DB call started prevents subsequent trader and alert processing', async t => {
  const { policy } = configured(t);
  const entered = deferred();
  const release = deferred();
  const { ingest, calls } = harness(policy, { db: async () => { entered.resolve(); return release.promise; } });
  const pending = ingest(CHANNEL, [message()]);
  await entered.promise;
  policy.setActive(CHANNEL, false);
  release.resolve();
  const result = await pending;
  assert.equal(result.accepted, 0);
  expectCounts(calls, { storage: 1, raw: 1, classify: 1, score: 1, db: 1, country: 1 });
});

test('revocation during the first message also blocks later members of the same batch', async t => {
  const { policy } = configured(t);
  const entered = deferred();
  const release = deferred();
  const { ingest, calls } = harness(policy, { classify: async () => { entered.resolve(); return release.promise; } });
  const pending = ingest(CHANNEL, [message(), unreadableMessage()]);
  await entered.promise;
  policy.setActive(CHANNEL, false);
  release.resolve({ ...CLASSIFICATION });
  assert.deepEqual(await pending, { accepted: 0, ignored: 2 });
  expectCounts(calls, { storage: 1, raw: 1, classify: 1 });
});

test('runtime corruption, deletion and even valid external edits invalidate the loaded policy', async t => {
  for (const change of [
    filename => fs.writeFileSync(filename, '{synthetic-corruption'),
    filename => fs.unlinkSync(filename),
    filename => {
      const replacement = JSON.parse(fs.readFileSync(filename, 'utf8'));
      replacement.channels[CHANNEL].groups[GROUP_ON].enabled = false;
      fs.writeFileSync(filename, JSON.stringify(replacement));
    },
  ]) {
    const { policy, filename } = configured(t);
    const before = fs.readFileSync(filename, 'utf8');
    change(filename);
    assert.equal(policy.allows(CHANNEL, GROUP_ON), false);
    assert.equal(policy.ready, false);
    assert.throws(() => policy.list(), status(503));
    assert.throws(() => policy.setActive(CHANNEL, true), status(503));
    const { ingest, calls } = harness(policy);
    assert.deepEqual(await ingest(CHANNEL, [unreadableMessage()]), { accepted: 0, ignored: 1 });
    expectCounts(calls);
    // A poisoned reader cannot silently recover merely because bytes return.
    fs.writeFileSync(filename, before);
    assert.equal(policy.allows(CHANNEL, GROUP_ON), false);
    assert.equal(new ChannelPolicy(filename).allows(CHANNEL, GROUP_ON), true);
  }
});

test('a second policy writer invalidates a stale reader and prevents stale overwrites', async t => {
  const { policy: reader, filename } = configured(t);
  const writer = new ChannelPolicy(filename);
  assert.equal(writer.allows(CHANNEL, GROUP_ON), true);
  writer.setGroups(CHANNEL, [{ id: GROUP_ON, enabled: false }]);
  const persisted = fs.readFileSync(filename, 'utf8');
  assert.equal(reader.allows(CHANNEL, GROUP_ON), false);
  assert.equal(reader.ready, false);
  assert.throws(() => reader.setGroups(CHANNEL, [{ id: GROUP_ON, enabled: true }]), status(503));
  assert.equal(fs.readFileSync(filename, 'utf8'), persisted);
  assert.equal(writer.ready, true);
  assert.equal(writer.allows(CHANNEL, GROUP_ON), false);
  const { ingest, calls } = harness(reader);
  assert.deepEqual(await ingest(CHANNEL, [unreadableMessage()]), { accepted: 0, ignored: 1 });
  expectCounts(calls);
});

test('runtime file read errors fail closed even for a previously enabled group', async t => {
  let unavailable = false;
  const io = { ...fs, readFileSync: (...args) => { if (unavailable) throw new Error('Synthetic lost mount'); return fs.readFileSync(...args); } };
  const { policy } = configured(t, { io });
  unavailable = true;
  const { ingest, calls } = harness(policy);
  assert.deepEqual(await ingest(CHANNEL, [unreadableMessage()]), { accepted: 0, ignored: 1 });
  expectCounts(calls);
  assert.equal(policy.ready, false);
  unavailable = false;
  assert.equal(policy.allows(CHANNEL, GROUP_ON), false);
});

test('policy corruption during classification prevents all later processing', async t => {
  const { policy, filename } = configured(t);
  const entered = deferred();
  const release = deferred();
  const { ingest, calls } = harness(policy, { classify: async () => { entered.resolve(); return release.promise; } });
  const pending = ingest(CHANNEL, [message()]);
  await entered.promise;
  fs.writeFileSync(filename, '{synthetic-runtime-corruption');
  release.resolve({ ...CLASSIFICATION });
  assert.deepEqual(await pending, { accepted: 0, ignored: 1 });
  expectCounts(calls, { storage: 1, raw: 1, classify: 1 });
});

test('failed save during classification blocks later processing even if disk access recovers', async t => {
  let fail = false;
  const io = { ...fs, renameSync: (...args) => { if (fail) throw new Error('Synthetic rename failure'); return fs.renameSync(...args); } };
  const { policy } = configured(t, { io });
  const entered = deferred();
  const release = deferred();
  const { ingest, calls } = harness(policy, { classify: async () => { entered.resolve(); return release.promise; } });
  const pending = ingest(CHANNEL, [message()]);
  await entered.promise;
  fail = true;
  assert.throws(() => policy.setActive(CHANNEL, false), status(503));
  fail = false;
  release.resolve({ ...CLASSIFICATION });
  assert.deepEqual(await pending, { accepted: 0, ignored: 1 });
  expectCounts(calls, { storage: 1, raw: 1, classify: 1 });
});

test('metadata-only group sync and repeated unchanged settings do not revoke a valid lease', async t => {
  const { policy } = configured(t);
  const entered = deferred();
  const release = deferred();
  const { ingest, calls } = harness(policy, { classify: async () => { entered.resolve(); return release.promise; } });
  const pending = ingest(CHANNEL, [message()]);
  await entered.promise;
  const before = policy.lease(CHANNEL, GROUP_ON);
  sync(policy, [{ id: GROUP_ON, name: 'Synthetic renamed group' }, { id: GROUP_NEW, name: 'Synthetic new group' }]);
  policy.setActive(CHANNEL, true);
  policy.setGroups(CHANNEL, [{ id: GROUP_ON, enabled: true }]);
  assert.equal(policy.lease(CHANNEL, GROUP_ON), before);
  release.resolve({ ...CLASSIFICATION });
  assert.deepEqual(await pending, { accepted: 1, ignored: 0 });
  expectCounts(calls, Object.fromEntries(COUNTER_NAMES.map(name => [name, 1])));
});

test('prototype-member channel names can be explicitly created, selected and tombstoned safely', t => {
  const { policy, filename } = fixture(t);
  for (const channel of ['constructor', 'toString', 'valueOf']) {
    policy.create(channel);
    sync(policy, [{ id: GROUP_ON }], channel);
    policy.setGroups(channel, [{ id: GROUP_ON, enabled: true }]);
    policy.setActive(channel, true);
    assert.equal(policy.allows(channel, GROUP_ON), true);
    policy.remove(channel);
    assert.equal(policy.get(channel), null);
    assert.equal(policy.allows(channel, GROUP_ON), false);
    assert.throws(() => policy.create(channel), status(409));
  }
  const restarted = new ChannelPolicy(filename);
  assert.deepEqual(restarted.list(), []);
  for (const channel of ['constructor', 'toString', 'valueOf']) assert.throws(() => restarted.create(channel), status(409));
});

test('policy lock enforces one owner, uses private permissions and permits explicit release', t => {
  const { filename } = fixture(t);
  const release = acquirePolicyLock(filename);
  const lockfile = filename + '.lock';
  const initial = fs.readFileSync(lockfile, 'utf8');
  assert.equal(fs.statSync(lockfile).mode & 0o777, 0o600);
  assert.throws(() => acquirePolicyLock(filename), /already locked or unavailable/);
  assert.equal(fs.readFileSync(lockfile, 'utf8'), initial);
  release();
  assert.equal(fs.existsSync(lockfile), false);
  const nextRelease = acquirePolicyLock(filename);
  const current = fs.readFileSync(lockfile, 'utf8');
  assert.notEqual(current, initial);
  release(); // An old owner must never remove a replacement owner's lock.
  assert.equal(fs.readFileSync(lockfile, 'utf8'), current);
  nextRelease();
  nextRelease(); // Releasing an already released lock is safe.
  assert.equal(fs.existsSync(lockfile), false);
});

test('a stale or externally replaced lock is retained rather than guessed safe', t => {
  const { filename } = fixture(t);
  const lockfile = filename + '.lock';
  fs.writeFileSync(lockfile, 'synthetic-stale-lock');
  assert.throws(() => acquirePolicyLock(filename), /already locked or unavailable/);
  assert.equal(fs.readFileSync(lockfile, 'utf8'), 'synthetic-stale-lock');
  fs.unlinkSync(lockfile);
  const release = acquirePolicyLock(filename);
  fs.writeFileSync(lockfile, 'synthetic-replacement-owner');
  release();
  assert.equal(fs.readFileSync(lockfile, 'utf8'), 'synthetic-replacement-owner');
});
