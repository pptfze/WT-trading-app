'use strict';
// Real server webhook handlers with a synthetic Mongo collection and blocked
// external I/O. No HTTP listener, driver, provider, credentials or network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const {fixtureMongo} = require('./fake-mongo');

const root = process.env.WT_REVIEW_REPO || path.resolve(__dirname, '..');
const serverFile = path.join(root, 'server.js');
const localRequire = createRequire(serverFile);
const SECRET = 'synthetic-webhook-material-never-transmit-0000';
const CHANNEL = 'synthetic-webhook-channel';
const GROUP = '120000000001@g.us';
const OFF = '120000000002@g.us';
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

async function fixture() {
  const calls = { fetch: [], ping: 0, insert: [], logs: [], extract:0 };
  const fake=fixtureMongo();
  const controls = { readError: false, pingError: false, beforeFetch: null };
  const app = { routes: [], middleware: [], disable() {}, use(fn) { this.middleware.push(fn); } };
  for (const method of ['get', 'post', 'patch', 'put', 'delete']) {
    app[method] = (route, ...handlers) => app.routes.push({ method, route, handlers });
  }
  function express() { return app; }
  express.json = express.static = () => () => {};
  const collection = {
    document: null,
    async updateOne(filter, update, options) {
      if(options.session) {
        assert.equal(options.upsert,false);
        if(!this.document || this.document.revision!==filter.revision)return {acknowledged:true,matchedCount:0,modifiedCount:0};
        this.document.revision+=update.$inc.revision;
        return {acknowledged:true,matchedCount:1,modifiedCount:1};
      }
      assert.equal(options.upsert, true);
      if (this.document) return { acknowledged: true, matchedCount: 1, modifiedCount: 0, upsertedCount: 0 };
      this.document = clone({ _id: filter._id, ...update.$setOnInsert });
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
    },
    async findOne(filter, options) {
      if (controls.readError) throw new Error('Synthetic policy storage failure');
      if(!options.session) { assert.equal(options.readPreference, 'primary');
      assert.equal(options.readConcern.level, 'linearizable'); }
      return clone(this.document);
    },
    async replaceOne(filter, replacement, options) {
      assert.equal(options.upsert, false);
      assert.equal(options.writeConcern.w, 'majority');
      if (!this.document || this.document.revision !== filter.revision) {
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
      }
      this.document = clone(replacement);
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
    },
  };
  const database = {
    async command() {
      calls.ping++;
      if (controls.pingError) throw new Error('Synthetic listing storage failure');
      return { ok: 1 };
    },
    collection(name) {
      if (name === 'channel_privacy') return collection;
      assert.ok(['group_listings_v1','group_messages_v1','group_matches_v1'].includes(name), 'No historical default-allow collection is accessible');
      const result=fake.db.collection(name);
      const original=result.insertMany;
      result.insertMany=async(listings,options)=>{const r=await original(listings,options);calls.insert.push(...clone(listings));return r;};
      return result;
    },
  };
  const moduleObject = { exports: {} };
  const context = {
    module: moduleObject, exports: moduleObject.exports, Buffer, Date, AbortSignal,
    __dirname: root,
    console: { log: (...args) => calls.logs.push(args), error: (...args) => calls.logs.push(args) },
    process: { env: {
      WHATSAPP_ENABLED: 'true', WEBHOOK_SECRET: SECRET,
      JWT_SECRET: 'synthetic-signing-material-never-transmit-000000',
      ADMIN_EMAILS: 'operator@example.invalid', CLAUDE_API_KEY: 'synthetic-key-never-transmit',
    } },
    setInterval() { throw new Error('Server scheduler must not start in this test'); },
    clearInterval() {},
    require(name) {
      if (name === 'express') return express;
      if (name === 'cors') return () => () => {};
      if (name === 'mongodb') throw new Error('Live database driver is forbidden');
      if(name === './lib/trade-ingestion') {const actual=localRequire(name);return {...actual,createTradeProcessor:opts=>actual.createTradeProcessor({...opts,extract:async text=>{calls.extract++;if(controls.beforeFetch)await controls.beforeFetch();return localRequire('./lib/trade-extraction').extractTradeItems(text);}})};}
      if (['path', 'crypto'].includes(name) || name.startsWith('./lib/')) return localRequire(name);
      throw new Error('Unexpected dependency: ' + name);
    },
    async fetch(url, options) {
      // This function only fabricates responses; it never calls any network API.
      assert.equal(url, 'https://api.anthropic.com/v1/messages');
      calls.fetch.push({ url, body: JSON.parse(options.body) });
      if (controls.beforeFetch) await controls.beforeFetch();
      const value = calls.fetch.length === 1
        ? { type: 'WTS', condition: 'Used', model: 'Synthetic handset', price: 100, currency: 'USD' }
        : { score: 5, isFlagged: false };
      return { async json() { return { content: [{ text: JSON.stringify(value) }] }; } };
    },
  };
  vm.createContext(context);
  // Test-only lexical injection avoids adding mutable production test hooks.
  const seam = '\nmodule.exports.__installSyntheticDb = async (value,client) => { db = value; tradeStore = new TradeStore(db,client); policy = new MongoChannelPolicy(db.collection("channel_privacy")); await policy.initialize(); };';
  vm.runInContext(fs.readFileSync(serverFile, 'utf8') + seam, context, { filename: serverFile });
  const server = moduleObject.exports;
  await server.__installSyntheticDb(database,fake.client);
  assert.equal(server.policy.ready, true);
  await server.policy.create(CHANNEL, 'Synthetic test channel');
  await server.policy.mergeGroups(CHANNEL, [{ id: GROUP, name: 'Selected synthetic group' }, { id: OFF, name: 'Unselected synthetic group' }], (await server.policy.get(CHANNEL)).generation);
  await server.policy.setGroups(CHANNEL, [{ id: GROUP, enabled: true }]);
  await server.policy.setActive(CHANNEL, true);

  async function webhook({ headers = { 'x-webhook-secret': SECRET }, query = { channel: CHANNEL }, body = { messages: [] } } = {}) {
    const result = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    let failure;
    await app.routes.find(route => route.route === '/webhook').handlers[0]({ headers, query, body }, result, error => { failure = error; });
    if (failure) await app.middleware.find(fn => fn.length === 4)(failure, {}, result, () => {});
    return result;
  }
  return { server, webhook, calls, controls, collection };
}

function unreadable(overrides = {}) {
  const message = { chat_id: GROUP, ...overrides };
  for (const key of ['text', 'caption', 'from', 'timestamp']) {
    Object.defineProperty(message, key, { get() { throw new Error('Rejected message content accessed: ' + key); } });
  }
  return message;
}
const trade = () => ({ id:'synthetic-provider-message', timestamp:Math.floor(Date.now()/1000), chat_id: GROUP, is_group: true, from: '10000000000@s.whatsapp.net', text: { body: 'WTS brand new iPhone 15 128GB USD 100 each' } });
function noContentSideEffects(f, expectedPing = 0) {
  assert.equal(f.calls.ping, expectedPing);
  assert.equal(f.calls.fetch.length, 0);
  assert.equal(f.calls.insert.length, 0);
  assert.equal(f.server.mem.rawMessages.length, 0);
  assert.equal(Object.keys(f.server.mem.traders).length, 0);
  assert.equal(f.calls.logs.length, 0);
}

test('enabled webhook rejects absent, incorrect or non-string authentication before all content sinks', async () => {
  const f = await fixture();
  for (const headers of [{}, { 'x-webhook-secret': 'wrong' }, { 'x-webhook-secret': [SECRET] }]) {
    assert.equal((await f.webhook({ headers, body: { messages: [unreadable()] } })).statusCode, 401);
  }
  noContentSideEffects(f);
});

test('enabled webhook requires explicit valid channel and bounded message array', async () => {
  const f = await fixture();
  for (const query of [{}, { channel: '' }, { channel: [CHANNEL] }, { channel: 'bad space' }]) {
    assert.equal((await f.webhook({ query, body: { messages: [unreadable()] } })).statusCode, 400);
  }
  for (const body of [{}, { messages: {} }, { messages: Array(1001).fill(null) }]) {
    assert.equal((await f.webhook({ body })).statusCode, 400);
  }
  noContentSideEffects(f);
});

test('enabled webhook rejects personal, unknown, malformed and conflicting IDs before reading text or calling storage/AI', async () => {
  const f = await fixture();
  const messages = [
    unreadable({ chat_id: undefined }), unreadable({ chat_id: '123@s.whatsapp.net' }),
    unreadable({ chat_id: 'status@broadcast' }), unreadable({ chat_id: '123@newsletter' }),
    unreadable({ chat_id: 'invalid@g.us' }), unreadable({ chat_id: GROUP + '.invalid' }),
    unreadable({ chat_id: '999@g.us' }), unreadable({ chat_id: OFF }),
    unreadable({ is_group: false }), unreadable({ is_group: 'true' }),
    unreadable({ chat_type: 'personal' }), unreadable({ from_me: true }),
  ];
  const result = await f.webhook({ body: { messages } });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.accepted, 0);
  assert.equal(result.body.ignored, messages.length);
  const forgedChannel = await f.webhook({ query: { channel: 'unknown-channel' }, body: { messages: [unreadable()] } });
  assert.equal(forgedChannel.body.ignored, 1);
  noContentSideEffects(f);
});

test('selected webhook messages are blocked before content access when listing storage or policy reads fail', async () => {
  const storage = await fixture();
  storage.controls.pingError = true;
  assert.equal((await storage.webhook({ body: { messages: [unreadable()] } })).statusCode, 503);
  noContentSideEffects(storage, 1);
  const policy = await fixture();
  policy.controls.readError = true;
  const result = await policy.webhook({ body: { messages: [unreadable()] } });
  assert.equal(result.statusCode, 503);
  assert.equal(policy.server.policy.ready, false);
  noContentSideEffects(policy);
  assert.equal((await policy.webhook()).statusCode, 503);
});

test('mixed webhook batch processes exactly one authenticated explicitly selected group using only synthetic I/O', async () => {
  const f = await fixture();
  const result = await f.webhook({ body: { messages: [unreadable({ chat_id: OFF }), unreadable({ chat_id: '123@s.whatsapp.net' }), trade()] } });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.accepted, 1);
  assert.equal(result.body.ignored, 2);
  assert.equal(f.calls.ping, 1);
  assert.equal(f.calls.fetch.length, 0);
  assert.equal(f.calls.extract,1);
  assert.equal(f.calls.insert.length, 1);
  assert.equal(f.server.mem.rawMessages.length, 0);
  assert.equal(f.calls.insert[0].channelId, CHANNEL);
  assert.equal(f.calls.insert[0].group, GROUP);
});

test('revocation during mocked extraction prevents all listing writes and external AI calls', async () => {
  const f = await fixture();
  f.controls.beforeFetch = async () => { await f.server.policy.setActive(CHANNEL, false); await f.server.policy.setActive(CHANNEL, true); };
  const result = await f.webhook({ body: { messages: [trade()] } });
  assert.equal(result.body.accepted, 0);
  assert.equal(result.body.ignored, 1);
  assert.equal(f.calls.fetch.length, 0);
  assert.equal(f.calls.extract,1);
  assert.equal(f.calls.insert.length, 0);
  assert.equal(Object.keys(f.server.mem.traders).length, 0);
});
