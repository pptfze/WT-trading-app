'use strict';
// Dependency-free UI contract tests. These execute the inline client in a small
// DOM stub with synthetic fetch replies; they are not a browser/visual QA pass.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const inline = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(x => x[1]).join('\n');
const feature = inline.split('// ── SERVER-BACKED SALES MATCHES ──')[1].split('// ── LIVE POLLING ──')[0];
function response(body, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => body }; }
function lead(overrides = {}) {
  const source = { provider: 'whapi', providerMessageId: 'provider-offer-1', channelId: 'channel-1', groupId: '120000000001@g.us', sourceTimestamp: 1700000000, lineIndex: 0 };
  return { id: 'lead-1', version: 1, status: 'new', assignedTo: null, flags: ['verify_color'], notes: [], updatedAt: '2026-10-12T12:00:00.000Z',
    comparison: { currency: 'AED', offerUnitPrice: 100, buyerUnitPrice: 120, unitSpread: 20, possibleQty: 2 },
    offer: { id: 'offer-1', model: 'Synthetic phone', storage: '256GB', price: 100, currency: 'AED', qty: 2, sender: 'seller', group: source.groupId, groupName: 'Selected sellers', source, timestamp: 1700000000 },
    demand: { id: 'demand-1', model: 'Synthetic phone', storage: '256GB', price: 120, currency: 'AED', qty: 3, sender: 'buyer', groupName: 'Selected buyers', source: { ...source, providerMessageId: 'provider-demand-1' }, timestamp: 1700000001 },
    ...overrides };
}
function payload(matches = [lead()]) { return { matches, limits: { freshnessHours: 48, inventoryReservation: false } }; }
function client(fetchImpl = async () => { throw new Error('Unexpected request'); }) {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, { value: id === 'matchFilter' ? 'all' : '', innerHTML: '', textContent: '', disabled: false, style: {}, attributes: {}, listeners: {}, classList: { add() {}, remove() {} }, setAttribute(k, v) { this.attributes[k] = v; }, addEventListener(k, v) { this.listeners[k] = v; } });
    return elements.get(id);
  }
  const requests = [];
  const context = vm.createContext({
    document: { getElementById: element, querySelectorAll: () => [], querySelector: () => element('selector') },
    window: { addEventListener() {} }, localStorage: { getItem: () => null, removeItem() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, AbortController,
    fetch: async (url, options) => { requests.push({ url, options }); return fetchImpl(url, options); },
  });
  vm.runInContext(inline, context);
  const run = source => vm.runInContext(source, context);
  run("S.token='synthetic-session'; S.user={email:'sales@example.invalid',role:'member',name:'Sales'};");
  return { run, element, requests, context, seed(match = lead()) { context.synthetic = match; run('M.items=[synthetic];M.verified=true;M.loadedAt=new Date();renderMatches();'); } };
}

test('Matches is an obvious non-admin tab with verification and inventory warnings', () => {
  assert.match(html, /data-tab="matches" onclick="showTab\('matches',this\)"/);
  assert.match(html, /id="pane-matches"/);
  assert.match(html, /does not reserve inventory/);
  assert.match(html, /No messages are sent from this view/);
  assert.match(html, /id="matchesStatus" role="status" aria-live="polite"/);
  assert.match(feature, /\/api\/matches\?limit=100/);
  assert.doesNotMatch(feature, /setInterval|localStorage|wa\.me|https?:\/\//);
  assert.match(inline, /if\(id==='channels'&&!isChannelAdmin\(\)&&!S\.isDemo\)/);
  assert.match(inline, /error\.status=r\.status/);
  assert.doesNotMatch(inline, /data-action="pipeline"|data-action="assign"|async function assignListing|async function setPipeline/);
  assert.match(inline, /Open sales matches · claim and track leads/);
});

test('demo and signed-out Matches make no API calls and clear previous leads', async () => {
  const c = client(); c.seed();
  c.run('S.isDemo=true;'); await c.run('refreshMatches()');
  assert.equal(c.requests.length, 0);
  assert.equal(c.run('M.items.length'), 0);
  assert.equal(c.element('refreshMatchesButton').disabled, true);
  assert.match(c.element('matchesStatus').textContent, /Demo mode makes no API requests/);
  c.run("S.isDemo=false;S.token='';"); await c.run('refreshMatches()');
  assert.equal(c.requests.length, 0);
});

test('bounded refresh does not overlap and preserves bearer auth', async () => {
  let release;
  const c = client(() => new Promise(resolve => { release = resolve; }));
  const pending = c.run('refreshMatches()');
  assert.equal(c.element('refreshMatchesButton').disabled, true);
  await c.run('refreshMatches()');
  assert.equal(c.requests.length, 1);
  assert.equal(c.requests[0].url, '/api/matches?limit=100');
  assert.equal(c.requests[0].options.headers.Authorization, 'Bearer synthetic-session');
  assert.equal(c.requests[0].options.cache, 'no-store');
  assert.ok(c.requests[0].options.signal instanceof AbortSignal);
  release(response(payload())); await pending;
  assert.equal(c.run('M.busy'), false);
  assert.equal(c.run('M.verified'), true);
  assert.equal(c.element('refreshMatchesButton').disabled, false);
  assert.match(c.element('matchesSummary').textContent, /1 shown · 1 open/);
});

test('render escapes provider text and shows both source IDs, times and explicit currency', () => {
  const m = lead();
  m.offer.groupName = '<img src=x onerror="unsafe()">';
  m.offer.source.providerMessageId = '<svg onload=unsafe()>';
  m.notes = [{ text: '</div><img src=x>', by: '<script>unsafe()</script>', at: m.updatedAt }];
  m.flags = ['<img src=x>']; m.id = 'lead" onclick="unsafe()';
  Object.assign(m.offer, { activation: 'Non-active', tradeClass: '14-day', supplierGrade: 'Supplier A', gradingNamespace: 'Synthetic supplier', gradingMethod: 'Manual visual check' });
  const c = client(); c.seed(m);
  const rendered = c.element('matchesList').innerHTML;
  assert.doesNotMatch(rendered, /<img|<svg|<script|onclick="unsafe/);
  assert.match(rendered, /&lt;img/);
  assert.match(rendered, /Provider message ID: &lt;svg/);
  assert.match(rendered, /Provider message ID: provider-demand-1/);
  assert.match(rendered, /Source time: 2023-11-14 22:13:20 UTC/);
  assert.match(rendered, /AED 100/);
  assert.match(rendered, /AED 20/);
  assert.match(rendered, /not profit/);
  assert.match(rendered, /Activation<\/dt><dd>Non-active/);
  assert.match(rendered, /Trade class<\/dt><dd>14-day/);
  assert.match(rendered, /Supplier grade<\/dt><dd>Supplier A/);
  assert.match(rendered, /Grading namespace<\/dt><dd>Synthetic supplier/);
  assert.match(rendered, /Grading method<\/dt><dd>Manual visual check/);
  assert.equal((rendered.match(/Seller offer · WTS/g) || []).length, 1);
  assert.equal((rendered.match(/Buyer demand · WTB/g) || []).length, 1);
  assert.doesNotMatch(rendered, /data-match-action="save"/);
});

test('unknown currency is explicit and does not imply a comparable margin', () => {
  const c = client(); const m = lead(); m.offer.currency = null; m.comparison = { unitSpread: 20, possibleQty: null }; c.seed(m);
  const rendered = c.element('matchesList').innerHTML;
  assert.match(rendered, /Currency unknown 100/);
  assert.match(rendered, /Not comparable from the available quotes/);
  assert.match(rendered, /Possible quantity overlap: Unknown/);
});

test('claim sends version only, disables repeated clicks, and reloads authoritative owner', async () => {
  let release;
  const claimed = lead({ version: 2, status: 'claimed', assignedTo: 'sales@example.invalid' });
  const c = client((url, options) => options.method === 'POST' ? new Promise(resolve => { release = resolve; }) : response(payload([claimed])));
  c.seed();
  const pending = c.run("updateMatch('lead-1','claim')");
  await c.run("updateMatch('lead-1','claim')");
  assert.equal(c.requests.length, 1);
  assert.equal(c.requests[0].url, '/api/matches/lead-1/claim');
  assert.deepEqual(JSON.parse(c.requests[0].options.body), { version: 1 });
  assert.match(c.element('matchesList').innerHTML, /data-match-action="claim" disabled/);
  release(response({ match: claimed })); await pending;
  assert.equal(c.requests.length, 2);
  assert.equal(c.run('M.items[0].assignedTo'), 'sales@example.invalid');
  assert.match(c.element('matchesList').innerHTML, /data-match-action="save"/);
  await c.run("updateMatch('lead-1','claim')");
  assert.equal(c.requests.length, 2);
});

test('owner PATCH sends version, selected status and internal note, then refreshes', async () => {
  const original = lead({ version: 4, status: 'claimed', assignedTo: 'sales@example.invalid' });
  const saved = { ...original, version: 5, status: 'contacted', notes: [{ text: 'Availability checked', by: 'sales@example.invalid', at: original.updatedAt }] };
  const c = client((url, options) => response(options.method === 'PATCH' ? { match: saved } : payload([saved])));
  c.seed(original); c.run("M.drafts.set('lead-1',{status:'contacted',note:' Availability checked '})");
  await c.run("updateMatch('lead-1','save')");
  assert.equal(c.requests[0].options.method, 'PATCH');
  assert.deepEqual(JSON.parse(c.requests[0].options.body), { version: 4, status: 'contacted', note: 'Availability checked' });
  assert.equal(c.run('M.items[0].status'), 'contacted');
  assert.equal(c.run("M.drafts.has('lead-1')"), false);
  assert.equal(c.run('M.busy'), false);
});

test('another sales user cannot update someone else’s lead, but admin can', async () => {
  const c = client((url, options) => response(options.method === 'PATCH' ? { match: lead() } : payload()));
  c.seed(lead({ assignedTo: 'other@example.invalid', status: 'claimed' }));
  c.run("M.drafts.set('lead-1',{status:'closed',note:''})");
  await c.run("updateMatch('lead-1','save')");
  assert.equal(c.requests.length, 0);
  assert.doesNotMatch(c.element('matchesList').innerHTML, /data-match-action="save"/);
  c.run("S.user.role='admin'");
  await c.run("updateMatch('lead-1','save')");
  assert.equal(c.requests.length, 2);
});

test('409 refreshes ownership, explains conflict and never retries mutation', async () => {
  const other = lead({ version: 2, status: 'claimed', assignedTo: 'other@example.invalid' });
  const c = client((url, options) => options.method === 'POST' ? response({ error: 'Version changed' }, 409) : response(payload([other])));
  c.seed(); await c.run("updateMatch('lead-1','claim')");
  assert.equal(c.requests.length, 2);
  assert.equal(c.requests.filter(r => r.options.method === 'POST').length, 1);
  assert.equal(c.run('M.items[0].assignedTo'), 'other@example.invalid');
  assert.match(c.element('matchesStatus').textContent, /Someone changed this lead/);
  assert.match(c.element('matchesStatus').textContent, /Your update was not applied/);
  assert.match(c.element('matchesStatus').textContent, /Latest available leads/);
  assert.doesNotMatch(c.element('matchesList').innerHTML, /data-match-action="save"|data-match-action="claim"/);
});

test('failed refresh disables stale edits and refresh removes unavailable sources', async () => {
  let failure = true;
  const c = client(() => failure ? response({ error: 'Unavailable' }, 503) : response(payload([])));
  c.seed(lead({ assignedTo: 'sales@example.invalid', status: 'claimed' }));
  c.run("M.drafts.set('lead-1',{note:'Keep until checked',status:''})");
  await c.run('refreshMatches()');
  assert.equal(c.run('M.verified'), false);
  assert.equal(c.run('M.items.length'), 1);
  assert.match(c.element('matchesList').innerHTML, /data-match-action="save" disabled/);
  await c.run("updateMatch('lead-1','save')");
  assert.equal(c.requests.length, 1);
  failure = false; await c.run('refreshMatches()');
  assert.equal(c.run('M.items.length'), 0);
  assert.equal(c.run('M.drafts.size'), 0);
  assert.doesNotMatch(c.element('matchesList').innerHTML, /Selected sellers/);
});

test('late response after session change cannot restore leads or overwrite new state', async () => {
  let release;
  const c = client(() => new Promise(resolve => { release = resolve; }));
  const pending = c.run('refreshMatches()');
  c.run("sessionVersion++;S.token='';S.user=null;resetMatches()");
  release(response(payload())); await pending;
  assert.equal(c.run('M.items.length'), 0);
  assert.equal(c.run('M.verified'), false);
  assert.equal(c.run('M.busy'), false);
  assert.equal(c.element('refreshMatchesButton').disabled, true);
});

test('notes can be saved independently on an owned closed lead', async () => {
  const owned = lead({ assignedTo: 'sales@example.invalid', status: 'closed', version: 7 });
  const c = client((url, options) => response(options.method === 'PATCH' ? { match: owned } : payload([owned])));
  c.seed(owned); c.run("M.drafts.set('lead-1',{status:'',note:'Manual closing reference'})");
  await c.run("updateMatch('lead-1','save')");
  assert.deepEqual(JSON.parse(c.requests[0].options.body), { version: 7, note: 'Manual closing reference' });
  assert.equal(c.requests[0].url, '/api/matches/lead-1');
});

test('conflict plus failed refresh keeps unsaved note but disables further mutations', async () => {
  const c = client((url, options) => response({ error: 'Synthetic failure' }, options.method === 'PATCH' ? 409 : 503));
  c.seed(lead({ assignedTo: 'sales@example.invalid', status: 'claimed' }));
  c.run("M.drafts.set('lead-1',{status:'contacted',note:'Keep this unsaved note'})");
  await c.run("updateMatch('lead-1','save')");
  assert.equal(c.requests.length, 2);
  assert.equal(c.run("M.drafts.get('lead-1').note"), 'Keep this unsaved note');
  assert.equal(c.run('M.verified'), false);
  assert.match(c.element('matchesStatus').textContent, /Refresh failed; editing is disabled/);
  await c.run("updateMatch('lead-1','save')");
  assert.equal(c.requests.length, 2);
});
