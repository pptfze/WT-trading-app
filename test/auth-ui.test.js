'use strict';
// Synthetic DOM VM only: browser/HTTPS smoke testing remains a staging gate.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const inline = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(x => x[1]).join('\n');
function fixture(fetcher) {
  const nodes = new Map(), requests = [], timers = [], removed = [];
  const element = id => { if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', innerHTML: '', style: {}, classList: { add() {}, remove() {}, contains() { return false; } } }); return nodes.get(id); };
  const context = vm.createContext({ document: { getElementById: element, querySelectorAll: () => [], querySelector: () => element('selector') }, window: { addEventListener() {} },
    localStorage: { getItem: () => null, removeItem: name => removed.push(name) }, AbortController, URLSearchParams,
    setInterval: () => 1, clearInterval() {}, setTimeout(fn, ms) { const timer = { fn, ms }; timers.push(timer); return timer; }, clearTimeout(timer) { timer.cleared = true; },
    fetch(url, options) { requests.push({ url, options }); return fetcher(url, options); }
  });
  vm.runInContext(inline, context); const run = code => vm.runInContext(code, context);
  run("S.token='synthetic-old-session';S.user={email:'owner@example.invalid',role:'admin'};S.listings=[{id:'private'}];resetFeedSync=()=>{};resetMatches=()=>{};resetPriceTrends=()=>{};renderChannels=()=>{};updateAll=()=>{};setPill=()=>{};closeModal=()=>{};");
  return { run, element, requests, timers, removed };
}
test('logout immediately clears private state, sends captured token once and confirms durable revocation', async () => {
  let release; const f = fixture(() => new Promise(resolve => { release = resolve; }));
  const pending = f.run('logout()');
  assert.equal(f.run('S.token'), ''); assert.equal(f.run('S.user'), null); assert.equal(f.run('S.listings.length'), 0);
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].url, '/api/auth/logout');
  assert.equal(f.requests[0].options.headers.Authorization, 'Bearer synthetic-old-session');
  assert.equal(f.requests[0].options.method, 'POST'); assert.equal(f.requests[0].options.cache, 'no-store');
  f.run('logout()'); assert.equal(f.requests.length, 1);
  release({ ok: true, json: async () => ({ allSessionsRevoked: true }) }); await pending;
  assert.match(f.element('loginErr').textContent, /Other sessions were revoked/);
  assert.equal(f.timers[0].cleared, true);
});
test('failed, malformed or unauthorized logout stays locally signed out and never claims revocation', async () => {
  for (const response of [{ ok: false, json: async () => ({}) }, { ok: true, json: async () => ({ ok: true }) }, null]) {
    const f = fixture(async () => { if (!response) throw Error('Synthetic outage'); return response; });
    await f.run('logout()'); assert.equal(f.run('S.token'), '');
    assert.match(f.element('loginErr').textContent, /not confirmed/); assert.equal(f.requests.length, 1);
  }
});
test('logout timeout aborts request, does not retry and warns without blocking local exit', async () => {
  const f = fixture((url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('Synthetic timeout')))));
  const pending = f.run('logout()'); assert.equal(f.timers[0].ms, 5000); f.timers[0].fn(); await pending;
  assert.equal(f.run('S.token'), ''); assert.equal(f.requests.length, 1); assert.match(f.element('loginErr').textContent, /not confirmed/);
});
test('late logout response cannot replace a newer login status or clear its token', async () => {
  let release; const f = fixture(() => new Promise(resolve => { release = resolve; }));
  const pending = f.run('logout()');
  f.run("sessionVersion++;S.token='new-session';S.user={email:'member@example.invalid'};document.getElementById('loginErr').textContent='New account';");
  release({ ok: true, json: async () => ({ allSessionsRevoked: true }) }); await pending;
  assert.equal(f.run('S.token'), 'new-session'); assert.equal(f.element('loginErr').textContent, 'New account');
});
test('demo logout and already signed-out state never send a server request', async () => {
  const f = fixture(() => { throw Error('Unexpected request'); }); f.run('S.isDemo=true;'); await f.run('logout()'); await f.run('logout()');
  assert.equal(f.requests.length, 0); assert.equal(f.run('S.isDemo'), false);
});
