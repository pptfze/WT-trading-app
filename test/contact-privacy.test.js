'use strict';

// Offline regression tests of the real policy adapters and ingestion gate.
// All identities, messages, filesystem fixtures and Mongo behavior are synthetic.
// Never import server.js, a provider SDK, a Mongo driver or production records.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ChannelPolicy, contactIdValid, contactIdFromPhone } = require('../lib/channel-policy');
const { MongoChannelPolicy, DOCUMENT_ID } = require('../lib/mongo-channel-policy');
const { createIngestor } = require('../lib/ingestion');

const CHANNEL = 'synthetic-contact-channel';
const OTHER_CHANNEL = 'synthetic-other-channel';
const GROUP = '100001@g.us';
const GROUP_OFF = '100002@g.us';
const PHONE = '+15550100001';
const DIGITS = PHONE.slice(1);
const CONTACT = DIGITS + '@s.whatsapp.net';
const OFF_PHONE = '+15550100002';
const OFF_CONTACT = OFF_PHONE.slice(1) + '@s.whatsapp.net';
const UNKNOWN_PHONE = '+15550100003';
const UNKNOWN_CONTACT = UNKNOWN_PHONE.slice(1) + '@s.whatsapp.net';
const TRADE = 'WTS synthetic handset 256GB USD 500 brand new';
const CLASSIFICATION = { type: 'WTS', condition: 'Brand New', model: 'Synthetic handset', price: 500, currency: 'USD' };
const SINKS = ['storage', 'raw', 'classify', 'country', 'score', 'db', 'trader', 'alerts', 'selected'];
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const status = expected => error => error instanceof Error && error.status === expected;

let networkAttempts = 0;
const originalFetch = global.fetch;
global.fetch = () => { networkAttempts++; throw new Error('Network is forbidden in contact privacy tests'); };
test.after(() => {
  global.fetch = originalFetch;
  assert.equal(networkAttempts, 0, 'This suite must remain fully offline');
});

class MockCollection {
  constructor(document = null) {
    this.document = clone(document);
    this.calls = { find: [], update: [], replace: [] };
    this.available = true;
    this.beforeReplace = null;
    this.conflicts = 0;
  }
  check() { if (!this.available) throw new Error('Synthetic Mongo unavailable'); }
  async findOne(filter, options) {
    this.calls.find.push(clone({ filter, options }));
    this.check();
    return this.document && this.document._id === filter._id ? clone(this.document) : null;
  }
  async updateOne(filter, update, options) {
    this.calls.update.push(clone({ filter, update, options }));
    this.check();
    assert.equal(options.upsert, true);
    assert.deepEqual(Object.keys(update), ['$setOnInsert']);
    if (this.document) return { acknowledged: true, matchedCount: 1, modifiedCount: 0, upsertedCount: 0 };
    this.document = clone({ _id: filter._id, ...update.$setOnInsert });
    return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: filter._id };
  }
  async replaceOne(filter, replacement, options) {
    this.calls.replace.push(clone({ filter, replacement, options }));
    this.check();
    if (this.beforeReplace) {
      const hook = this.beforeReplace;
      this.beforeReplace = null;
      await hook();
    }
    this.check();
    if (this.replaceError) throw this.replaceError;
    if (this.replaceResult) return clone(this.replaceResult);
    assert.equal(options.upsert, false);
    assert.equal(replacement._id, filter._id);
    assert.equal(replacement.revision, filter.revision + 1);
    if (!this.document || this.document._id !== filter._id || this.document.revision !== filter.revision) {
      this.conflicts++;
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
    }
    this.document = clone(replacement);
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  }
}

async function fixture(t, kind = 'file', state) {
  if (kind === 'mongo') {
    const collection = new MockCollection(state && { _id: DOCUMENT_ID, revision: 0, ...clone(state) });
    const policy = new MongoChannelPolicy(collection);
    assert.equal(await policy.initialize(), true);
    return { policy, collection, snapshot: () => clone(collection.document), restart: async () => {
      const restarted = new MongoChannelPolicy(collection);
      assert.equal(await restarted.initialize(), true);
      return restarted;
    } };
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-contact-privacy-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'policy.json');
  if (state) fs.writeFileSync(filename, JSON.stringify(state));
  const policy = new ChannelPolicy(filename);
  assert.equal(policy.ready, true);
  return { policy, filename, snapshot: () => JSON.parse(fs.readFileSync(filename, 'utf8')), restart: async () => {
    const restarted = new ChannelPolicy(filename);
    assert.equal(restarted.ready, true);
    return restarted;
  } };
}

async function configured(t, kind = 'file') {
  const result = await fixture(t, kind);
  const { policy } = result;
  const channel = await policy.create(CHANNEL, 'Synthetic contacts');
  await policy.mergeGroups(CHANNEL, [{ id: GROUP, name: 'Synthetic group' }, { id: GROUP_OFF }], channel.generation);
  await policy.setGroups(CHANNEL, [{ id: GROUP, enabled: true }]);
  await policy.addContact(CHANNEL, { phone: PHONE, name: 'Synthetic selected contact' });
  await policy.addContact(CHANNEL, { phone: OFF_PHONE, name: 'Synthetic OFF contact' });
  await policy.setContacts(CHANNEL, [{ id: CONTACT, enabled: true }]);
  await policy.setActive(CHANNEL, true);
  return result;
}

function message(overrides = {}) {
  return { chat_id: CONTACT, from_me: false, from: CONTACT, timestamp: 1700000000, text: { body: TRADE }, ...overrides };
}

function groupMessage(overrides = {}) {
  return message({ chat_id: GROUP, is_group: true, chat_type: 'group', from: 'synthetic-group-sender@s.whatsapp.net', ...overrides });
}

function unreadableMessage(overrides = {}, unreadableIdentity = false) {
  const msg = message(overrides);
  const keys = ['text', 'caption', 'timestamp'];
  if (unreadableIdentity) keys.push('from');
  for (const key of keys) Object.defineProperty(msg, key, { get() { throw new Error(`Rejected contact ${key} was read`); } });
  return msg;
}

function harness(policy, overrides = {}) {
  const calls = Object.fromEntries(SINKS.map(name => [name, []]));
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
    ...(overrides.selected ? { processSelected: wrap('selected', overrides.selected) } : {}),
  });
  return { ingest, calls };
}

function expectCounts(calls, expected = {}) {
  for (const name of SINKS) assert.equal(calls[name].length, expected[name] || 0, `${name} call count`);
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('contact identifiers and international phone conversion are exact and bounded', () => {
  for (const phone of ['+12345678', PHONE, '+123456789012345']) {
    const id = phone.slice(1) + '@s.whatsapp.net';
    assert.equal(contactIdFromPhone(phone), id);
    assert.equal(contactIdValid(id), true);
  }
  const invalidPhones = [undefined, null, 15550100001, {}, [], '', DIGITS, '5550100001', '+012345678', '+1234567', '+1234567890123456', '+1 5550100001', '+1-555-010-0001', ' +15550100001', PHONE + ' ', PHONE + '\n', PHONE + '\r', PHONE + '\0', '++15550100001', '+１５５５０１００００１', CONTACT, DIGITS + '@c.us', DIGITS + '@lid'];
  for (const phone of invalidPhones) {
    let result;
    try { result = contactIdFromPhone(phone); } catch (error) { assert.ok(error instanceof Error); }
    assert.equal(contactIdValid(result), false, String(phone));
  }
  for (const id of [undefined, null, 12345678, {}, [], '', PHONE, DIGITS, '1234567@s.whatsapp.net', '012345678@s.whatsapp.net', '1234567890123456@s.whatsapp.net', '+' + CONTACT, CONTACT + ' ', ' ' + CONTACT, CONTACT + '\n', CONTACT + '\r', CONTACT + '\0', CONTACT + '.evil', CONTACT.toUpperCase(), DIGITS + '@c.us', DIGITS + '@lid', GROUP, 'status@broadcast', '12345678@newsletter']) {
    assert.equal(contactIdValid(id), false, String(id));
  }
});

for (const kind of ['file', 'mongo']) {
  test(`${kind}: new contacts stay OFF until explicitly selected on an active channel`, async t => {
    const { policy, restart } = await fixture(t, kind);
    await policy.create(CHANNEL);
    await policy.addContact(CHANNEL, { phone: PHONE, name: 'Synthetic contact' });
    const contact = (await policy.get(CHANNEL)).contacts[CONTACT];
    assert.equal(contact.id, CONTACT);
    assert.equal(contact.phone, PHONE);
    assert.equal(contact.name, 'Synthetic contact');
    assert.equal(contact.enabled, false);
    assert.equal(await policy.allows(CHANNEL, CONTACT), false);
    await policy.setActive(CHANNEL, true);
    assert.equal(await policy.allows(CHANNEL, CONTACT), false);
    assert.equal(await policy.lease(CHANNEL, CONTACT), null);
    const blocked = harness(policy);
    assert.deepEqual(await blocked.ingest(CHANNEL, [unreadableMessage()]), { accepted: 0, ignored: 1 });
    expectCounts(blocked.calls);
    await policy.setContacts(CHANNEL, [{ id: CONTACT, enabled: true }]);
    assert.equal(await policy.allows(CHANNEL, CONTACT), true);
    assert.equal(typeof await policy.lease(CHANNEL, CONTACT), 'string');
    const restarted = await restart();
    assert.equal(await restarted.allows(CHANNEL, CONTACT), true);
    assert.deepEqual((await restarted.get(CHANNEL)).contacts[CONTACT], contact && { ...contact, enabled: true });
  });

  test(`${kind}: legacy group-only documents load unchanged and require an explicit new contact selection`, async t => {
    const state = { version: 1, channels: { [CHANNEL]: { id: CHANNEL, label: 'Legacy synthetic', active: true, generation: 'synthetic-legacy-generation', authorizationVersion: 0, groups: { [GROUP]: { id: GROUP, name: 'Synthetic legacy group', participants: 3, enabled: true } } } }, deleted: {} };
    const { policy, snapshot } = await fixture(t, kind, state);
    const before = snapshot();
    assert.equal(await policy.allows(CHANNEL, GROUP), true);
    assert.equal(await policy.allows(CHANNEL, CONTACT), false);
    assert.equal(await policy.lease(CHANNEL, CONTACT), null);
    assert.deepEqual(snapshot(), before, 'Reading a legacy document must not rewrite it');
    const blocked = harness(policy);
    assert.deepEqual(await blocked.ingest(CHANNEL, [unreadableMessage()]), { accepted: 0, ignored: 1 });
    expectCounts(blocked.calls);
    await policy.addContact(CHANNEL, { phone: PHONE, name: 'Explicit new contact' });
    assert.equal((await policy.get(CHANNEL)).contacts[CONTACT].enabled, false);
    assert.equal(await policy.allows(CHANNEL, GROUP), true);
  });

  test(`${kind}: channel, group and contact selections are independent and detached from returned objects`, async t => {
    const { policy } = await configured(t, kind);
    await policy.create(OTHER_CHANNEL);
    await policy.addContact(OTHER_CHANNEL, { phone: PHONE, name: 'Same contact elsewhere' });
    await policy.setActive(OTHER_CHANNEL, true);
    assert.equal(await policy.allows(OTHER_CHANNEL, CONTACT), false);
    assert.equal(await policy.allows(CHANNEL, CONTACT), true);
    assert.equal(await policy.allows(CHANNEL, OFF_CONTACT), false);
    assert.equal(await policy.allows(CHANNEL, UNKNOWN_CONTACT), false);
    assert.equal(await policy.allows(CHANNEL, GROUP), true);
    const returned = await policy.get(CHANNEL);
    returned.contacts[CONTACT].enabled = false;
    returned.contacts[OFF_CONTACT].enabled = true;
    assert.equal(await policy.allows(CHANNEL, CONTACT), true);
    assert.equal(await policy.allows(CHANNEL, OFF_CONTACT), false);
    await policy.setGroups(CHANNEL, [{ id: GROUP, enabled: false }]);
    assert.equal(await policy.allows(CHANNEL, CONTACT), true);
    await policy.setContacts(CHANNEL, [{ id: CONTACT, enabled: false }]);
    await policy.setGroups(CHANNEL, [{ id: GROUP, enabled: true }]);
    assert.equal(await policy.allows(CHANNEL, CONTACT), false);
    assert.equal(await policy.allows(CHANNEL, GROUP), true);
    await assert.rejects(async () => policy.setContacts(CHANNEL, [{ id: GROUP, enabled: true }]), status(400));
    await assert.rejects(async () => policy.setGroups(CHANNEL, [{ id: CONTACT, enabled: true }]), status(400));
  });

  test(`${kind}: invalid contact mutations are atomic and never guess or alias identities`, async t => {
    const { policy, snapshot } = await configured(t, kind);
    const before = snapshot();
    const invalid = [
      ...[null, [], {}, { phone: DIGITS }, { phone: PHONE + '\n' }, { phone: '+' + CONTACT }, { phone: UNKNOWN_PHONE, name: {} }].map(contact => () => policy.addContact(CHANNEL, contact)),
      () => policy.setContacts(CHANNEL, [{ id: CONTACT, enabled: false }, { id: UNKNOWN_CONTACT, enabled: true }]),
      () => policy.setContacts(CHANNEL, [{ id: OFF_CONTACT, enabled: 'true' }]),
      () => policy.setContacts(CHANNEL, [{ id: OFF_CONTACT, enabled: 1 }]),
      () => policy.setContacts(CHANNEL, [{ id: DIGITS + '@c.us', enabled: true }]),
      () => policy.setContacts(CHANNEL, [{ id: DIGITS + '@lid', enabled: true }]),
      () => policy.setContacts(CHANNEL, [{ id: CONTACT + '\n', enabled: true }]),
      () => policy.setContacts(CHANNEL, {}),
      () => policy.removeContact(CHANNEL, GROUP),
      () => policy.removeContact(CHANNEL, UNKNOWN_CONTACT),
    ];
    for (const action of invalid) {
      await assert.rejects(async () => action());
      assert.deepEqual(snapshot(), before);
      assert.equal(policy.ready, true);
    }
  });

  test(`${kind}: pause, contact OFF, removal and channel deletion revoke leases and survive restart`, async t => {
    const { policy, restart, snapshot } = await configured(t, kind);
    const original = await policy.lease(CHANNEL, CONTACT);
    const groupLease = await policy.lease(CHANNEL, GROUP);
    await policy.setContacts(CHANNEL, [{ id: OFF_CONTACT, enabled: true }]);
    assert.notEqual(await policy.lease(CHANNEL, CONTACT), original);
    assert.notEqual(await policy.lease(CHANNEL, GROUP), groupLease);
    const beforeGroupChange = await policy.lease(CHANNEL, CONTACT);
    await policy.setGroups(CHANNEL, [{ id: GROUP_OFF, enabled: true }]);
    assert.notEqual(await policy.lease(CHANNEL, CONTACT), beforeGroupChange);
    const beforePause = await policy.lease(CHANNEL, CONTACT);
    await policy.setActive(CHANNEL, false);
    assert.equal(await policy.lease(CHANNEL, CONTACT), null);
    assert.equal((await policy.get(CHANNEL)).contacts[CONTACT].enabled, true);
    await policy.setActive(CHANNEL, true);
    assert.notEqual(await policy.lease(CHANNEL, CONTACT), beforePause);
    const beforeOff = await policy.lease(CHANNEL, CONTACT);
    await policy.setContacts(CHANNEL, [{ id: CONTACT, enabled: false }]);
    assert.equal(await policy.lease(CHANNEL, CONTACT), null);
    await policy.setContacts(CHANNEL, [{ id: CONTACT, enabled: true }]);
    assert.notEqual(await policy.lease(CHANNEL, CONTACT), beforeOff);
    await policy.removeContact(CHANNEL, CONTACT);
    assert.equal(await policy.allows(CHANNEL, CONTACT), false);
    assert.equal((await policy.get(CHANNEL)).contacts[CONTACT], undefined);
    assert.equal(snapshot().channels[CHANNEL].deletedContacts[CONTACT], true);
    const restarted = await restart();
    assert.equal(await restarted.allows(CHANNEL, CONTACT), false);
    await assert.rejects(async () => restarted.addContact(CHANNEL, { phone: PHONE, name: 'Stale recreation' }), status(409));
    await assert.rejects(async () => restarted.setContacts(CHANNEL, [{ id: CONTACT, enabled: true }]));
    assert.equal(await restarted.allows(CHANNEL, GROUP), true);
    await restarted.remove(CHANNEL);
    assert.equal(await restarted.allows(CHANNEL, OFF_CONTACT), false);
    assert.equal(await restarted.allows(CHANNEL, GROUP), false);
    await assert.rejects(async () => restarted.create(CHANNEL), status(409));
  });

  test(`${kind}: duplicate contact additions cannot reset selections or bypass tombstones`, async t => {
    const { policy, snapshot } = await configured(t, kind);
    const before = snapshot();
    await assert.rejects(async () => policy.addContact(CHANNEL, { phone: PHONE, name: 'Replacement' }), status(409));
    assert.deepEqual(snapshot(), before);
    await policy.removeContact(CHANNEL, OFF_CONTACT);
    await assert.rejects(async () => policy.addContact(CHANNEL, { phone: OFF_PHONE, name: 'Replacement' }), status(409));
    assert.equal(await policy.allows(CHANNEL, CONTACT), true);
  });

  test(`${kind}: selected incoming contacts accept only explicit matching sender identity`, async t => {
    const { policy } = await configured(t, kind);
    const { ingest, calls } = harness(policy, { selected: async () => 1 });
    const messages = [message(), message({ from: DIGITS }), message({ is_group: false, chat_type: 'contact' }), message({ chat_type: 'private' }), message({ chat_type: 'personal' })];
    assert.deepEqual(await ingest(CHANNEL, messages), { accepted: messages.length, ignored: 0 });
    expectCounts(calls, { storage: messages.length, selected: messages.length });
    for (let i = 0; i < messages.length; i++) {
      const [received, context] = calls.selected[i];
      assert.equal(received, messages[i]);
      assert.equal(context.channelId, CHANNEL);
      assert.equal(context.sourceType, 'contact');
      assert.equal(context.sourceId, CONTACT);
      assert.equal(context.contactPhone, PHONE);
      assert.equal(await context.allowed(), true);
    }
  });

  test(`${kind}: unknown and OFF contacts never read content or reach processSelected, raw, AI or DB`, async t => {
    const { policy } = await configured(t, kind);
    const { ingest, calls } = harness(policy, { selected: async () => 1 });
    for (const chat_id of [OFF_CONTACT, UNKNOWN_CONTACT, DIGITS + '@c.us', DIGITS + '@lid', CONTACT + '\n', PHONE, DIGITS, 'status@broadcast']) {
      assert.deepEqual(await ingest(CHANNEL, [unreadableMessage({ chat_id, from: chat_id })]), { accepted: 0, ignored: 1 }, chat_id);
    }
    expectCounts(calls);
  });

  test(`${kind}: malformed, outgoing, LID and spoofed contact identities are discarded before content or sinks`, async t => {
    const { policy } = await configured(t, kind);
    const { ingest, calls } = harness(policy, { selected: async () => 1 });
    const malformed = [
      ...[true, undefined, null, 0, 1, 'false', 'true', {}, []].map(from_me => ({ from_me })),
      ...[true, undefined, null, 0, 1, 'false', 'true', {}, []].map(fromMe => ({ fromMe })),
      ...[true, undefined, null, 0, 1, 'false', {}, []].map(is_group => ({ is_group })),
      ...['group', 'PRIVATE', '', undefined, null, 0, {}, []].map(chat_type => ({ chat_type })),
      ...[undefined, null, 0, {}, [], UNKNOWN_CONTACT, OFF_CONTACT, OFF_PHONE.slice(1), PHONE, DIGITS + '@c.us', DIGITS + '@lid', CONTACT + '.evil', CONTACT + '\n', CONTACT + ' ', ' ' + CONTACT, DIGITS + '\n', '0' + DIGITS].map(from => ({ from })),
      ...['sender_id', 'sender', 'author', 'participant'].flatMap(field => [OFF_CONTACT, DIGITS + '@lid', PHONE, null].map(value => ({ [field]: value }))),
      ...[null, [], { id: OFF_CONTACT }, { id: DIGITS + '@lid' }, { type: 'group' }].map(chat => ({ chat })),
    ];
    for (const overrides of malformed) {
      assert.deepEqual(await ingest(CHANNEL, [unreadableMessage(overrides)]), { accepted: 0, ignored: 1 }, JSON.stringify(overrides));
    }
    const missingDirection = unreadableMessage();
    delete missingDirection.from_me;
    assert.deepEqual(await ingest(CHANNEL, [missingDirection]), { accepted: 0, ignored: 1 });
    const missingSender = unreadableMessage();
    delete missingSender.from;
    assert.deepEqual(await ingest(CHANNEL, [missingSender]), { accepted: 0, ignored: 1 });
    expectCounts(calls);
  });
}

test('group selection remains independent and processSelected receives its group identity', async t => {
  const { policy } = await configured(t);
  const { ingest, calls } = harness(policy, { selected: async () => 1 });
  const legacy = groupMessage();
  delete legacy.from_me;
  delete legacy.is_group;
  delete legacy.chat_type;
  assert.deepEqual(await ingest(CHANNEL, [groupMessage(), legacy]), { accepted: 2, ignored: 0 });
  for (const [, context] of calls.selected) {
    assert.equal(context.sourceType, 'group');
    assert.equal(context.sourceId, GROUP);
    assert.ok(context.contactPhone == null);
    assert.equal(await context.allowed(), true);
  }
  const rejected = harness(policy, { selected: async () => 1 });
  for (const from_me of [true, undefined, null, 0, 1, 'false', 'true', {}, []]) {
    const msg = unreadableMessage({ chat_id: GROUP, is_group: true, chat_type: 'group', from_me }, true);
    assert.deepEqual(await rejected.ingest(CHANNEL, [msg]), { accepted: 0, ignored: 1 });
  }
  expectCounts(rejected.calls);
});

test('fallback raw retention and listing records preserve selected contact identity', async t => {
  const { policy } = await configured(t);
  const { ingest, calls } = harness(policy);
  assert.deepEqual(await ingest(CHANNEL, [message({ from: DIGITS, is_group: false, chat_type: 'private' })]), { accepted: 1, ignored: 0 });
  expectCounts(calls, { storage: 1, raw: 1, classify: 1, country: 1, score: 1, db: 1, trader: 1, alerts: 1 });
  for (const record of [calls.raw[0][0], calls.db[0][0]]) {
    assert.equal(record.channelId, CHANNEL);
    assert.equal(record.sender, DIGITS);
    assert.equal(record.sourceType, 'contact');
    assert.equal(record.sourceId, CONTACT);
    assert.equal(record.contactPhone, PHONE);
    assert.notEqual(record.group, GROUP);
  }
  assert.equal(calls.raw[0][0].text, TRADE);
  assert.equal(calls.db[0][0].raw, TRADE);
  assert.deepEqual(calls.classify[0], [TRADE, DIGITS]);
});

test('a mixed batch passes only selected contacts and selected groups to the processor', async t => {
  const { policy } = await configured(t);
  const { ingest, calls } = harness(policy, { selected: async () => 1 });
  const batch = [message(), unreadableMessage({ chat_id: OFF_CONTACT, from: OFF_CONTACT }), unreadableMessage({ chat_id: UNKNOWN_CONTACT, from: UNKNOWN_CONTACT }), unreadableMessage({ from: DIGITS + '@lid' }), groupMessage(), unreadableMessage({ chat_id: GROUP_OFF, is_group: true, from: CONTACT }), unreadableMessage({ from_me: true })];
  assert.deepEqual(await ingest(CHANNEL, batch), { accepted: 2, ignored: 5 });
  assert.deepEqual(calls.selected.map(([, context]) => [context.sourceType, context.sourceId]), [['contact', CONTACT], ['group', GROUP]]);
  expectCounts(calls, { storage: 2, selected: 2 });
});

for (const revocation of ['contact-off', 'contact-off-on', 'contact-delete', 'pause', 'pause-resume', 'channel-delete', 'group-change']) {
  test(`contact revocation during classification (${revocation}) prevents later AI and writes`, async t => {
    const { policy } = await configured(t);
    const entered = deferred();
    const release = deferred();
    const { ingest, calls } = harness(policy, { classify: async () => { entered.resolve(); return release.promise; } });
    const pending = ingest(CHANNEL, [message()]);
    await entered.promise;
    if (revocation.startsWith('contact-off')) await policy.setContacts(CHANNEL, [{ id: CONTACT, enabled: false }]);
    if (revocation === 'contact-off-on') await policy.setContacts(CHANNEL, [{ id: CONTACT, enabled: true }]);
    if (revocation === 'contact-delete') await policy.removeContact(CHANNEL, CONTACT);
    if (revocation.startsWith('pause')) await policy.setActive(CHANNEL, false);
    if (revocation === 'pause-resume') await policy.setActive(CHANNEL, true);
    if (revocation === 'channel-delete') await policy.remove(CHANNEL);
    if (revocation === 'group-change') await policy.setGroups(CHANNEL, [{ id: GROUP, enabled: false }]);
    release.resolve({ ...CLASSIFICATION });
    assert.deepEqual(await pending, { accepted: 0, ignored: 1 });
    expectCounts(calls, { storage: 1, raw: 1, classify: 1 });
  });
}

for (const phase of ['storage', 'classify']) {
  test(`contact identity changes during ${phase} invalidate the original authorization`, async t => {
    for (const mutation of [
      msg => { msg.chat_id = OFF_CONTACT; msg.from = OFF_CONTACT; },
      msg => { msg.from = OFF_CONTACT; },
      msg => { msg.from_me = true; },
      msg => { msg.is_group = true; },
    ]) {
      const { policy } = await configured(t);
      await policy.setContacts(CHANNEL, [{ id: OFF_CONTACT, enabled: true }]);
      const entered = deferred();
      const release = deferred();
      const { ingest, calls } = harness(policy, { [phase]: async () => { entered.resolve(); return release.promise; } });
      const msg = phase === 'storage' ? unreadableMessage() : message();
      const pending = ingest(CHANNEL, [msg]);
      await entered.promise;
      mutation(msg);
      release.resolve(phase === 'storage' ? true : { ...CLASSIFICATION });
      assert.deepEqual(await pending, { accepted: 0, ignored: 1 });
      expectCounts(calls, phase === 'storage' ? { storage: 1 } : { storage: 1, raw: 1, classify: 1 });
    }
  });
}

test('contact revocation during storage checks prevents content and processor access', async t => {
  const { policy } = await configured(t);
  const entered = deferred();
  const release = deferred();
  const { ingest, calls } = harness(policy, { storage: async () => { entered.resolve(); return release.promise; }, selected: async () => 1 });
  const pending = ingest(CHANNEL, [unreadableMessage()]);
  await entered.promise;
  await policy.removeContact(CHANNEL, CONTACT);
  release.resolve(true);
  assert.deepEqual(await pending, { accepted: 0, ignored: 1 });
  expectCounts(calls, { storage: 1 });
});

test('processSelected receives a contact guard that stays revoked after OFF then ON', async t => {
  const { policy } = await configured(t);
  const entered = deferred();
  const release = deferred();
  let guard;
  const { ingest, calls } = harness(policy, { selected: async (msg, context) => {
    guard = context.allowed;
    entered.resolve();
    await release.promise;
    return await guard() ? 1 : 0;
  } });
  const pending = ingest(CHANNEL, [message()]);
  await entered.promise;
  assert.equal(await guard(), true);
  await policy.setContacts(CHANNEL, [{ id: CONTACT, enabled: false }]);
  await policy.setContacts(CHANNEL, [{ id: CONTACT, enabled: true }]);
  assert.equal(await guard(), false);
  release.resolve();
  assert.deepEqual(await pending, { accepted: 0, ignored: 1 });
  expectCounts(calls, { storage: 1, selected: 1 });
});

test('Mongo contact decisions read fresh primary policy and independent adapters observe revocation', async t => {
  const { policy, collection, restart } = await configured(t, 'mongo');
  const second = await restart();
  let reads = collection.calls.find.length;
  assert.equal(await second.allows(CHANNEL, CONTACT), true);
  assert.equal(collection.calls.find.length, ++reads);
  const lease = await second.lease(CHANNEL, CONTACT);
  assert.equal(collection.calls.find.length, ++reads);
  await policy.setContacts(CHANNEL, [{ id: CONTACT, enabled: false }]);
  assert.equal(await second.allows(CHANNEL, CONTACT), false);
  await policy.setContacts(CHANNEL, [{ id: CONTACT, enabled: true }]);
  assert.notEqual(await second.lease(CHANNEL, CONTACT), lease);
  await policy.removeContact(CHANNEL, CONTACT);
  assert.equal(await second.allows(CHANNEL, CONTACT), false);
  for (const { filter, options } of collection.calls.find) {
    assert.deepEqual(filter, { _id: DOCUMENT_ID });
    assert.equal(options.readPreference, 'primary');
    assert.equal(options.readConcern.level, 'linearizable');
  }
  for (const { filter, replacement, options } of collection.calls.replace) {
    assert.equal(replacement.revision, filter.revision + 1);
    assert.equal(options.upsert, false);
    assert.equal(options.writeConcern.w, 'majority');
  }
});

for (const revoke of ['contact-off', 'contact-delete', 'pause', 'channel-delete', 'group-off']) {
  test(`Mongo stale contact enables cannot override a concurrent ${revoke}`, async t => {
    const { policy, collection, restart } = await configured(t, 'mongo');
    const second = await restart();
    collection.beforeReplace = async () => {
      if (revoke === 'contact-off') await policy.setContacts(CHANNEL, [{ id: CONTACT, enabled: false }]);
      if (revoke === 'contact-delete') await policy.removeContact(CHANNEL, CONTACT);
      if (revoke === 'pause') await policy.setActive(CHANNEL, false);
      if (revoke === 'channel-delete') await policy.remove(CHANNEL);
      if (revoke === 'group-off') await policy.setGroups(CHANNEL, [{ id: GROUP, enabled: false }]);
    };
    await assert.rejects(second.setContacts(CHANNEL, [{ id: CONTACT, enabled: true }]), status(409));
    assert.equal(collection.conflicts, 1);
    assert.equal(second.ready, true);
    if (revoke === 'group-off') assert.equal(await second.allows(CHANNEL, GROUP), false);
    else assert.equal(await second.allows(CHANNEL, CONTACT), false);
  });
}

test('Mongo racing OFF-contact additions retry safely and retain a concurrent pause', async t => {
  const { policy, collection, restart } = await configured(t, 'mongo');
  const second = await restart();
  collection.beforeReplace = async () => { await policy.setActive(CHANNEL, false); };
  await second.addContact(CHANNEL, { phone: UNKNOWN_PHONE, name: 'Added concurrently' });
  assert.equal(collection.conflicts, 1);
  const channel = await second.get(CHANNEL);
  assert.equal(channel.active, false);
  assert.equal(channel.contacts[UNKNOWN_CONTACT].enabled, false);
  assert.equal(channel.contacts[CONTACT].enabled, true);
  assert.equal(await second.allows(CHANNEL, CONTACT), false);
});

test('Mongo a racing contact removal preserves its tombstone against stale create', async t => {
  const { policy, collection, restart } = await configured(t, 'mongo');
  const second = await restart();
  collection.beforeReplace = async () => {
    await policy.addContact(CHANNEL, { phone: UNKNOWN_PHONE, name: 'Concurrent contact' });
    await policy.removeContact(CHANNEL, UNKNOWN_CONTACT);
  };
  await assert.rejects(second.addContact(CHANNEL, { phone: UNKNOWN_PHONE, name: 'Stale create' }), status(409));
  assert.equal(collection.conflicts, 1);
  const channel = await second.get(CHANNEL);
  assert.equal(channel.contacts[UNKNOWN_CONTACT], undefined);
  assert.equal(channel.deletedContacts[UNKNOWN_CONTACT], true);
  assert.equal(await second.allows(CHANNEL, UNKNOWN_CONTACT), false);
});

test('Mongo concurrent changes to another channel survive contact selection CAS retry', async t => {
  const { policy, collection, restart } = await configured(t, 'mongo');
  const second = await restart();
  collection.beforeReplace = async () => { await policy.create(OTHER_CHANNEL, 'Concurrent channel'); };
  await second.setContacts(CHANNEL, [{ id: OFF_CONTACT, enabled: true }]);
  assert.equal(collection.conflicts, 1);
  assert.equal(await second.allows(CHANNEL, OFF_CONTACT), true);
  assert.equal((await second.get(OTHER_CHANNEL)).label, 'Concurrent channel');
});

test('Mongo outage prevents even selected-contact body reads and remains fail-closed until restart', async t => {
  const { policy, collection, restart } = await configured(t, 'mongo');
  collection.available = false;
  const { ingest, calls } = harness(policy, { selected: async () => 1 });
  assert.deepEqual(await ingest(CHANNEL, [unreadableMessage()]), { accepted: 0, ignored: 1 });
  expectCounts(calls);
  assert.equal(policy.ready, false);
  collection.available = true;
  assert.equal(await policy.allows(CHANNEL, CONTACT), false);
  assert.equal(await policy.lease(CHANNEL, CONTACT), null);
  const restarted = await restart();
  assert.equal(await restarted.allows(CHANNEL, CONTACT), true);
});

test('Mongo outage during contact classification prevents subsequent scoring and persistence', async t => {
  const { policy, collection } = await configured(t, 'mongo');
  const entered = deferred();
  const release = deferred();
  const { ingest, calls } = harness(policy, { classify: async () => { entered.resolve(); return release.promise; } });
  const pending = ingest(CHANNEL, [message()]);
  await entered.promise;
  collection.available = false;
  release.resolve({ ...CLASSIFICATION });
  assert.deepEqual(await pending, { accepted: 0, ignored: 1 });
  expectCounts(calls, { storage: 1, raw: 1, classify: 1 });
  assert.equal(policy.ready, false);
});

test('uncertain Mongo contact revocation writes poison the adapter without pretending settings were saved', async t => {
  const { policy, collection } = await configured(t, 'mongo');
  const before = clone(collection.document);
  collection.replaceResult = { acknowledged: false };
  await assert.rejects(policy.setContacts(CHANNEL, [{ id: CONTACT, enabled: false }]), status(503));
  assert.deepEqual(collection.document, before);
  assert.equal(policy.ready, false);
  assert.equal(await policy.allows(CHANNEL, CONTACT), false);
  const { ingest, calls } = harness(policy);
  assert.deepEqual(await ingest(CHANNEL, [unreadableMessage()]), { accepted: 0, ignored: 1 });
  expectCounts(calls);
});
