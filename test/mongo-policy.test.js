'use strict';

// Fully synthetic Mongo behavior. No Mongo driver, server, credentials, network,
// filesystem persistence or production records are required by this suite.
const test = require('node:test');
const assert = require('node:assert/strict');
const { MongoChannelPolicy, DOCUMENT_ID, COLLECTION_NAME } = require('../lib/mongo-channel-policy');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const CHANNEL = 'synthetic-channel';
const SELECTED = '100001@g.us';
const OFF = '100002-100003@g.us';
const UNKNOWN = '100004@g.us';
const status = expected => error => error instanceof Error && error.status === expected;

class MockCollection {
  constructor(document = null) {
    this.document = clone(document);
    this.calls = { find: [], update: [], replace: [] };
    this.available = true;
    this.beforeReplace = null;
    this.conflicts = 0;
  }
  assertAvailable() { if (!this.available) throw new Error('Synthetic database unavailable; sensitive internal details'); }
  async findOne(filter, options) {
    this.calls.find.push(clone({ filter, options }));
    this.assertAvailable();
    if (this.findError) throw this.findError;
    return this.document && this.document._id === filter._id ? clone(this.document) : null;
  }
  async updateOne(filter, update, options) {
    this.calls.update.push(clone({ filter, update, options }));
    this.assertAvailable();
    if (this.updateError) throw this.updateError;
    if (this.updateResult) return clone(this.updateResult);
    assert.equal(options.upsert, true);
    assert.deepEqual(Object.keys(update), ['$setOnInsert']);
    if (this.document) {
      assert.equal(this.document._id, filter._id);
      return { acknowledged: true, matchedCount: 1, modifiedCount: 0, upsertedCount: 0 };
    }
    this.document = clone({ _id: filter._id, ...update.$setOnInsert });
    return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: filter._id };
  }
  async replaceOne(filter, replacement, options) {
    this.calls.replace.push(clone({ filter, replacement, options }));
    this.assertAvailable();
    if (this.beforeReplace) {
      const hook = this.beforeReplace;
      this.beforeReplace = null;
      await hook(filter, replacement);
    }
    this.assertAvailable();
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

async function fresh(collection = new MockCollection()) {
  const policy = new MongoChannelPolicy(collection);
  assert.equal(policy.ready, false);
  assert.equal(await policy.initialize(), true);
  return { policy, collection };
}
async function configured() {
  const fixture = await fresh();
  const { policy } = fixture;
  const channel = await policy.create(CHANNEL, 'Synthetic channel');
  await policy.mergeGroups(CHANNEL, [
    { id: SELECTED, name: 'Synthetic selected', participants: 3 },
    { id: OFF, name: 'Synthetic off' }
  ], channel.generation);
  await policy.setGroups(CHANNEL, [{ id: SELECTED, enabled: true }]);
  await policy.setActive(CHANNEL, true);
  return fixture;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('initialization creates only the durable default-deny document and accepts a Mongo Db', async () => {
  const collection = new MockCollection();
  let selected;
  const policy = new MongoChannelPolicy({ collection(name) { selected = name; return collection; } });
  assert.equal(selected, COLLECTION_NAME);
  assert.equal(policy.ready, false);
  assert.equal(await policy.allows(CHANNEL, SELECTED), false);
  assert.equal(await policy.lease(CHANNEL, SELECTED), null);
  await assert.rejects(policy.list(), status(503));
  assert.equal(collection.calls.find.length, 0);
  assert.equal(await policy.initialize(), true);
  assert.equal(policy.ready, true);
  assert.deepEqual(collection.document, { _id: DOCUMENT_ID, revision: 0, version: 1, channels: {}, deleted: {} });
  assert.deepEqual(await policy.list(), []);
  assert.equal(await policy.get(CHANNEL), null);
  assert.equal(await policy.allows(CHANNEL, SELECTED), false);
  assert.equal(await policy.initialize(), true);
  assert.equal(collection.calls.update.length, 1);
});

test('new channels and provider-discovered groups start OFF, including supplied enable flags and unknown fields', async () => {
  const { policy, collection } = await fresh();
  const channel = await policy.create(CHANNEL);
  assert.equal(channel.active, false);
  assert.equal(channel.authorizationVersion, 0);
  assert.equal(channel.label, CHANNEL);
  await policy.mergeGroups(CHANNEL, [
    { id: SELECTED, name: 'Synthetic', enabled: true, token: 'synthetic-secret' },
    { id: OFF, participants: 5, enabled: true },
    { id: '100001@s.whatsapp.net', name: 'Personal' },
    { id: 'status@broadcast' },
    { id: '100001@newsletter' },
    null, 'invalid'
  ], channel.generation);
  const result = await policy.get(CHANNEL);
  assert.deepEqual(Object.keys(result.groups), [SELECTED, OFF]);
  for (const group of Object.values(result.groups)) assert.equal(group.enabled, false);
  assert.equal(await policy.allows(CHANNEL, SELECTED), false);
  await policy.setActive(CHANNEL, true);
  assert.equal(await policy.allows(CHANNEL, SELECTED), false);
  assert.equal(JSON.stringify(collection.document).includes('synthetic-secret'), false);
  assert.equal(JSON.stringify(await policy.list()).includes('token'), false);
});

test('only active selected groups are allowed and every decision/read fetches fresh primary data', async () => {
  const { policy, collection } = await configured();
  let reads = collection.calls.find.length;
  assert.equal(await policy.allows(CHANNEL, SELECTED), true);
  assert.equal(collection.calls.find.length, ++reads);
  assert.equal(typeof await policy.lease(CHANNEL, SELECTED), 'string');
  assert.equal(collection.calls.find.length, ++reads);
  await policy.list();
  assert.equal(collection.calls.find.length, ++reads);
  await policy.get(CHANNEL);
  assert.equal(collection.calls.find.length, ++reads);
  for (const [channel, group] of [[CHANNEL, OFF], [CHANNEL, UNKNOWN], ['unknown', SELECTED], ['constructor', SELECTED], ['__proto__', SELECTED], [CHANNEL, '100001@s.whatsapp.net'], [CHANNEL, undefined], [null, SELECTED]]) {
    assert.equal(await policy.allows(channel, group), false);
    assert.equal(collection.calls.find.length, ++reads);
    assert.equal(await policy.lease(channel, group), null);
    assert.equal(collection.calls.find.length, ++reads);
  }
  for (const call of collection.calls.find) {
    assert.equal(call.options.readPreference, 'primary');
    assert.equal(call.options.readConcern.level, 'linearizable');
    assert.equal(call.options.maxTimeMS, 5000);
    assert.deepEqual(call.filter, { _id: DOCUMENT_ID });
  }
});

test('restart preserves selections, channel generation, epochs, and tombstones without replacing existing data', async () => {
  const { policy, collection } = await configured();
  const original = await policy.get(CHANNEL);
  const snapshot = clone(collection.document);
  const { policy: restarted } = await fresh(collection);
  assert.deepEqual(collection.document, snapshot);
  assert.deepEqual(await restarted.get(CHANNEL), original);
  assert.equal(await restarted.allows(CHANNEL, SELECTED), true);
  await restarted.remove(CHANNEL);
  const deleted = clone(collection.document);
  const { policy: afterDeletion } = await fresh(collection);
  assert.deepEqual(collection.document, deleted);
  assert.equal(await afterDeletion.get(CHANNEL), null);
  assert.equal(await afterDeletion.allows(CHANNEL, SELECTED), false);
  await assert.rejects(afterDeletion.create(CHANNEL), status(409));
  assert.equal(collection.document.deleted[CHANNEL], true);
});

test('independent adapters immediately observe pause, resume, group revocation, and delete', async () => {
  const { policy: first, collection } = await configured();
  const { policy: second } = await fresh(collection);
  const before = await second.lease(CHANNEL, SELECTED);
  assert.equal(await second.allows(CHANNEL, SELECTED), true);
  await first.setActive(CHANNEL, false);
  assert.equal(await second.allows(CHANNEL, SELECTED), false);
  assert.equal(await second.lease(CHANNEL, SELECTED), null);
  await first.setActive(CHANNEL, true);
  assert.notEqual(await second.lease(CHANNEL, SELECTED), before);
  const resumed = await second.lease(CHANNEL, SELECTED);
  await first.setGroups(CHANNEL, [{ id: SELECTED, enabled: false }]);
  assert.equal(await second.allows(CHANNEL, SELECTED), false);
  await first.setGroups(CHANNEL, [{ id: SELECTED, enabled: true }]);
  assert.notEqual(await second.lease(CHANNEL, SELECTED), resumed);
  await first.remove(CHANNEL);
  assert.equal(await second.allows(CHANNEL, SELECTED), false);
  assert.equal(await second.get(CHANNEL), null);
  await assert.rejects(second.create(CHANNEL), status(409));
});

test('returned data is detached and sync preserves selections without changing authorization leases', async () => {
  const { policy } = await configured();
  const before = await policy.lease(CHANNEL, SELECTED);
  const channel = await policy.get(CHANNEL);
  channel.active = false;
  channel.groups[SELECTED].enabled = false;
  const listed = await policy.list();
  listed[0].groups[SELECTED].enabled = false;
  await policy.mergeGroups(CHANNEL, [{ id: SELECTED, name: 'Updated' }, { id: UNKNOWN, name: 'New', enabled: true }], channel.generation);
  assert.equal(await policy.lease(CHANNEL, SELECTED), before);
  assert.equal(await policy.allows(CHANNEL, UNKNOWN), false);
  assert.equal((await policy.get(CHANNEL)).groups[SELECTED].name, 'Updated');
  await policy.setActive(CHANNEL, true);
  await policy.setGroups(CHANNEL, [{ id: SELECTED, enabled: true }]);
  assert.equal(await policy.lease(CHANNEL, SELECTED), before);
});

test('all valid writes use exact revision CAS with majority acknowledgment and no upsert', async () => {
  const { collection } = await configured();
  assert.equal(collection.document.revision, 4);
  assert.equal(collection.calls.replace.length, 4);
  collection.calls.replace.forEach((call, index) => {
    assert.deepEqual(call.filter, { _id: DOCUMENT_ID, revision: index });
    assert.equal(call.replacement.revision, index + 1);
    assert.equal(call.options.upsert, false);
    assert.equal(call.options.writeConcern.w, 'majority');
    assert.equal(call.options.writeConcern.wtimeoutMS, 5000);
  });
  assert.equal(collection.calls.update[0].options.writeConcern.w, 'majority');
});

test('racing metadata synchronization re-reads after CAS conflict and preserves a newer pause', async () => {
  const { policy: first, collection } = await configured();
  const { policy: second } = await fresh(collection);
  const generation = (await second.get(CHANNEL)).generation;
  const priorRevision = collection.document.revision;
  collection.beforeReplace = async () => { await first.setActive(CHANNEL, false); };
  await second.mergeGroups(CHANNEL, [{ id: UNKNOWN, name: 'Racing sync' }], generation);
  assert.equal(collection.conflicts, 1);
  assert.equal(collection.document.revision, priorRevision + 2);
  assert.equal((await second.get(CHANNEL)).active, false);
  assert.equal((await second.get(CHANNEL)).groups[UNKNOWN].enabled, false);
  assert.equal(await first.allows(CHANNEL, SELECTED), false);
  assert.equal(second.ready, true);
});

test('racing metadata synchronization preserves a newer group deselection', async () => {
  const { policy: first, collection } = await configured();
  const { policy: second } = await fresh(collection);
  const generation = (await second.get(CHANNEL)).generation;
  collection.beforeReplace = async () => { await first.setGroups(CHANNEL, [{ id: SELECTED, enabled: false }]); };
  await second.mergeGroups(CHANNEL, [{ id: SELECTED, name: 'Updated concurrently' }], generation);
  assert.equal(collection.conflicts, 1);
  assert.equal(await second.allows(CHANNEL, SELECTED), false);
  assert.equal((await second.get(CHANNEL)).groups[SELECTED].name, 'Updated concurrently');
});

test('racing sync cannot restore a deleted channel or clear its tombstone', async () => {
  const { policy: first, collection } = await configured();
  const { policy: second } = await fresh(collection);
  const generation = (await second.get(CHANNEL)).generation;
  collection.beforeReplace = async () => { await first.remove(CHANNEL); };
  await assert.rejects(second.mergeGroups(CHANNEL, [{ id: UNKNOWN }], generation), status(404));
  assert.equal(collection.conflicts, 1);
  assert.equal(collection.document.deleted[CHANNEL], true);
  assert.equal(await second.allows(CHANNEL, SELECTED), false);
  assert.equal(second.ready, true);
});

test('older authorization grants do not retry across a newer revocation epoch', async () => {
  const { policy: first, collection } = await configured();
  const { policy: second } = await fresh(collection);
  collection.beforeReplace = async () => { await first.setActive(CHANNEL, false); };
  await assert.rejects(second.setGroups(CHANNEL, [{ id: OFF, enabled: true }]), status(409));
  assert.equal(collection.conflicts, 1);
  assert.equal((await second.get(CHANNEL)).active, false);
  assert.equal((await second.get(CHANNEL)).groups[OFF].enabled, false);
  assert.equal(second.ready, true);
});

test('stale idempotent enable operations cannot undo concurrent channel or group revocations', async () => {
  for (const kind of ['channel', 'group']) {
    const { policy: first, collection } = await configured();
    const { policy: second } = await fresh(collection);
    collection.beforeReplace = async () => {
      if (kind === 'channel') await first.setActive(CHANNEL, false);
      else await first.setGroups(CHANNEL, [{ id: SELECTED, enabled: false }]);
    };
    const update = kind === 'channel' ? second.setActive(CHANNEL, true)
      : second.setGroups(CHANNEL, [{ id: SELECTED, enabled: true }]);
    await assert.rejects(update, status(409));
    assert.equal(collection.conflicts, 1);
    assert.equal(await second.allows(CHANNEL, SELECTED), false);
    assert.equal(second.ready, true);
  }
});

test('racing channel creates cannot overwrite the winning channel', async () => {
  const { policy: first, collection } = await fresh();
  const { policy: second } = await fresh(collection);
  collection.beforeReplace = async () => { await first.create(CHANNEL, 'Winner'); };
  await assert.rejects(second.create(CHANNEL, 'Stale writer'), status(409));
  assert.equal((await second.get(CHANNEL)).label, 'Winner');
  assert.equal(collection.conflicts, 1);
});

test('unrelated concurrent mutations are retained after a fresh CAS retry', async () => {
  const { policy: first, collection } = await configured();
  const { policy: second } = await fresh(collection);
  collection.beforeReplace = async () => { await first.create('another-channel', 'Another'); };
  await second.setActive(CHANNEL, false);
  assert.equal(collection.conflicts, 1);
  assert.equal((await second.get(CHANNEL)).active, false);
  assert.equal((await second.get('another-channel')).label, 'Another');
});

test('invalid mutations validate atomically and do not write or poison healthy storage', async () => {
  const { policy, collection } = await configured();
  const before = clone(collection.document);
  const writes = collection.calls.replace.length;
  const bad = [
    () => policy.create('../invalid'),
    () => policy.create('new', 'x'.repeat(161)),
    () => policy.create(CHANNEL),
    () => policy.setActive(CHANNEL, 'true'),
    () => policy.setActive('missing', false),
    () => policy.remove('missing'),
    () => policy.mergeGroups(CHANNEL, [], 'stale-generation'),
    () => policy.mergeGroups(CHANNEL, {}, 'invalid'),
    () => policy.setGroups(CHANNEL, [{ id: SELECTED, enabled: false }, { id: UNKNOWN, enabled: true }]),
    () => policy.setGroups(CHANNEL, [{ id: SELECTED, enabled: 'false' }]),
    () => policy.setGroups(CHANNEL, [{ id: '100001@s.whatsapp.net', enabled: false }]),
    () => policy.setGroups(CHANNEL, new Array(5001).fill({ id: SELECTED, enabled: false }))
  ];
  for (const call of bad) await assert.rejects(call());
  assert.deepEqual(collection.document, before);
  assert.equal(collection.calls.replace.length, writes);
  assert.equal(policy.ready, true);
  assert.equal(await policy.allows(CHANNEL, SELECTED), true);
});

test('database outage blocks the first allow check and poisons until a new adapter starts', async () => {
  const { policy, collection } = await configured();
  collection.available = false;
  assert.equal(await policy.allows(CHANNEL, SELECTED), false);
  assert.equal(policy.ready, false);
  const reads = collection.calls.find.length;
  collection.available = true;
  assert.equal(await policy.lease(CHANNEL, SELECTED), null);
  assert.equal(await policy.allows(CHANNEL, SELECTED), false);
  await assert.rejects(policy.get(CHANNEL), error => error.status === 503 && !error.message.includes('sensitive'));
  await assert.rejects(policy.list(), status(503));
  await assert.rejects(policy.setActive(CHANNEL, true), status(503));
  assert.equal(await policy.initialize(), false);
  assert.equal(collection.calls.find.length, reads);
  const { policy: restarted } = await fresh(collection);
  assert.equal(await restarted.allows(CHANNEL, SELECTED), true);
});

test('initially unreachable Mongo never becomes ready or falls back to in-memory defaults', async () => {
  const collection = new MockCollection();
  collection.available = false;
  const policy = new MongoChannelPolicy(collection);
  assert.equal(await policy.initialize(), false);
  assert.equal(policy.ready, false);
  assert.equal(await policy.allows(CHANNEL, SELECTED), false);
  collection.available = true;
  assert.equal(await policy.initialize(), false);
  assert.equal(collection.document, null);
  assert.equal(collection.calls.update.length, 1);
});

test('corrupt or unknown-field documents fail initialization without overwriting existing data', async () => {
  const { collection: seed } = await configured();
  const valid = seed.document;
  const cases = [
    doc => { doc.version = 2; },
    doc => { doc.revision = -1; },
    doc => { doc.revision = 1.5; },
    doc => { delete doc.revision; },
    doc => { doc.token = 'synthetic-secret'; },
    doc => { doc.channels[CHANNEL].token = 'synthetic-secret'; },
    doc => { doc.channels[CHANNEL].groups[SELECTED].token = 'synthetic-secret'; },
    doc => { doc.channels[CHANNEL].groups[SELECTED].participants = '3'; },
    doc => { doc.channels[CHANNEL].groups[SELECTED].enabled = 'true'; },
    doc => { doc.channels[CHANNEL].authorizationVersion = -1; },
    doc => { doc.channels[CHANNEL].generation = ''; },
    doc => { doc.deleted[CHANNEL] = true; },
    doc => { doc.deleted.missing = false; },
    doc => { doc.channels[CHANNEL].groups['100001@s.whatsapp.net'] = { id: '100001@s.whatsapp.net', name: 'Personal', participants: 1, enabled: true }; }
  ];
  for (const corrupt of cases) {
    const document = clone(valid);
    corrupt(document);
    const collection = new MockCollection(document);
    const policy = new MongoChannelPolicy(collection);
    assert.equal(await policy.initialize(), false);
    assert.equal(await policy.allows(CHANNEL, SELECTED), false);
    assert.equal(policy.ready, false);
    assert.deepEqual(collection.document, document);
    assert.equal(collection.calls.replace.length, 0);
  }
});

test('runtime deletion/corruption is detected on the next decision and cannot silently recover', async () => {
  for (const corrupt of [collection => { collection.document = null; }, collection => { collection.document.unexpected = true; }]) {
    const { policy, collection } = await configured();
    const valid = clone(collection.document);
    corrupt(collection);
    assert.equal(await policy.lease(CHANNEL, SELECTED), null);
    assert.equal(policy.ready, false);
    collection.document = valid;
    assert.equal(await policy.allows(CHANNEL, SELECTED), false);
  }
});

test('unacknowledged or malformed initialization writes never enable ingestion', async () => {
  for (const result of [{ acknowledged: false }, {}, { acknowledged: true, matchedCount: 0, upsertedCount: 0 }]) {
    const collection = new MockCollection();
    collection.updateResult = result;
    const policy = new MongoChannelPolicy(collection);
    assert.equal(await policy.initialize(), false);
    assert.equal(policy.ready, false);
    assert.equal(await policy.allows(CHANNEL, SELECTED), false);
    assert.equal(collection.calls.find.length, 0);
  }
});

test('failed or uncertain writes poison the adapter and never acknowledge a saved revocation', async () => {
  const failures = [
    { replaceError: new Error('Synthetic write error with internal details') },
    { replaceResult: { acknowledged: false } },
    { replaceResult: {} },
    { replaceResult: { acknowledged: true, matchedCount: 1, modifiedCount: 0 } },
    { replaceResult: { acknowledged: true, matchedCount: 2, modifiedCount: 1 } }
  ];
  for (const failure of failures) {
    const { policy, collection } = await configured();
    const before = clone(collection.document);
    Object.assign(collection, failure);
    await assert.rejects(policy.setActive(CHANNEL, false), error => error.status === 503 && !error.message.includes('internal'));
    assert.equal(policy.ready, false);
    assert.equal(await policy.allows(CHANNEL, SELECTED), false);
    assert.deepEqual(collection.document, before);
    assert.equal(await policy.initialize(), false);
  }
});

test('an exhausted CAS conflict bound fails closed instead of claiming the mutation succeeded', async () => {
  const { policy, collection } = await configured();
  const writes = collection.calls.replace.length;
  const reads = collection.calls.find.length;
  collection.replaceResult = { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
  await assert.rejects(policy.setActive(CHANNEL, false), status(503));
  assert.equal(collection.calls.replace.length - writes, 16);
  assert.equal(collection.calls.find.length - reads, 16);
  assert.equal(policy.ready, false);
  assert.equal(await policy.allows(CHANNEL, SELECTED), false);
});

test('overlapping initialization shares one operation and an in-flight read cannot clear poisoning', async () => {
  const collection = new MockCollection();
  const policy = new MongoChannelPolicy(collection);
  assert.deepEqual(await Promise.all([policy.initialize(), policy.initialize(), policy.initialize()]), [true, true, true]);
  assert.equal(collection.calls.update.length, 1);
  const channel = await policy.create(CHANNEL);
  await policy.mergeGroups(CHANNEL, [{ id: SELECTED }], channel.generation);
  await policy.setGroups(CHANNEL, [{ id: SELECTED, enabled: true }]);
  await policy.setActive(CHANNEL, true);
  const started = deferred();
  const resume = deferred();
  const original = collection.findOne.bind(collection);
  let first = true;
  collection.findOne = async (...args) => {
    if (first) {
      first = false;
      const result = await original(...args);
      started.resolve();
      await resume.promise;
      return result;
    }
    throw new Error('Synthetic parallel read failure');
  };
  const pending = policy.allows(CHANNEL, SELECTED);
  await started.promise;
  assert.equal(await policy.allows(CHANNEL, SELECTED), false);
  resume.resolve();
  assert.equal(await pending, false);
  assert.equal(policy.ready, false);
});

test('revision and authorization epoch overflow cannot acknowledge a privacy change', async () => {
  for (const field of ['revision', 'authorizationVersion']) {
    const { policy, collection } = await configured();
    if (field === 'revision') collection.document.revision = Number.MAX_SAFE_INTEGER;
    else collection.document.channels[CHANNEL].authorizationVersion = Number.MAX_SAFE_INTEGER;
    await assert.rejects(policy.setActive(CHANNEL, false), status(503));
    assert.equal(policy.ready, false);
    assert.equal(await policy.allows(CHANNEL, SELECTED), false);
  }
});
