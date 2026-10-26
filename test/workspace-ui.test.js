'use strict';
// Dependency-free UI contract tests run the inline client in a minimal DOM VM.
// All requests are synthetic; these tests are not browser, visual or live QA.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const inline = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]).join('\n');
function response(body, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => body }; }
function listing(overrides = {}) {
  return { id: 'seller-offer', model: 'Synthetic offer', type: 'WTS', price: 111, currency: 'USD', condition: 'Brand New', sender: '971500000001', time: new Date(), ...overrides };
}
function channel(overrides = {}) {
  return { id: 'channel/one', label: 'Selected sources', active: false, groups: {}, contacts: { '971500000001@s.whatsapp.net': { id: '971500000001@s.whatsapp.net', phone: '+971500000001', name: 'Known seller', enabled: false } }, ...overrides };
}
function series(overrides = {}) {
  return {
    dimensions: { model: 'Synthetic phone', storage: '256GB', currency: 'USD', kind: 'seller_ask', condition: 'Brand New' },
    summary: { median: 111, min: 101, max: 121, sampleCount: 4, uniqueSourceCount: 3, staleSampleCount: 1 },
    trend: { status: 'unavailable', reasons: ['insufficient_completed_periods'] },
    buckets: [{ start: '2026-10-01T00:00:00.000Z', complete: true, median: 101, sampleCount: 2, uniqueSourceCount: 2 }, { start: '2026-10-08T00:00:00.000Z', complete: false, median: 121, sampleCount: 2, uniqueSourceCount: 1 }],
    warnings: [], evidence: [{ id: 'listing-1', sourceRef: 'source-ref-1', observedAt: '2026-10-10T10:00:00.000Z', price: 111, freshness: 'fresh' }], ...overrides,
  };
}
function analysis(items = [series()]) { return { asOf: '2026-10-12T10:00:00.000Z', counts: { included: 4, excluded: 2, duplicatesRemoved: 1 }, series: items, exclusions: [], limitations: ['Observed asks and budgets are not completed sale prices.'] }; }
function client(fetchImpl = async () => { throw new Error('Unexpected request'); }, options = {}) {
  const elements = new Map(), requests = [], timers = [], toasts = [], confirmations = [], storage = new Map(Object.entries(options.storage || {})), events = new Map();
  function node(id = '') {
    const classes = new Set();
    return { id, value: id === 'matchFilter' ? 'all' : '', innerHTML: '', textContent: '', checked: false, disabled: false, hidden: false, style: {}, attributes: {}, listeners: {}, children: [], dataset: {},
      classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) },
      setAttribute(key, value) { this.attributes[key] = value; }, addEventListener(key, value) { this.listeners[key] = value; },
      append(...children) { this.children.push(...children); }, appendChild(child) { this.children.push(child); }, replaceChildren(...children) { this.children = children; }, remove() {},
    };
  }
  function element(id) { if (!elements.has(id)) elements.set(id, node(id)); return elements.get(id); }
  const tabs = [...html.matchAll(/data-tab="([^"]+)"/g)].map(match => { const item = element('tab-' + match[1]); item.dataset.tab = match[1]; return item; });
  const panes = [...html.matchAll(/id="(pane-[^"]+)"/g)].map(match => element(match[1]));
  const chips = Array.from({ length: 9 }, (_, index) => element('chip-' + index));
  const context = vm.createContext({
    document: {
      getElementById: element, createElement: () => node(), body: node('body'),
      querySelectorAll: selector => selector === '.pane' ? panes : selector === '.tab' ? tabs : selector.includes('.chip') ? chips : [],
      querySelector: selector => { const match = selector.match(/data-tab=["']?([\w-]+)/); return element(match ? 'tab-' + match[1] : 'selector'); },
    },
    window: { addEventListener: (name, callback) => events.set(name, callback) },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) },
    setTimeout: (callback, milliseconds) => { const timer = { callback, milliseconds, cleared: false }; timers.push(timer); return timer; },
    clearTimeout: timer => { if (timer) timer.cleared = true; }, setInterval: () => 1, clearInterval() {},
    AbortController, URLSearchParams,
    confirm: message => { confirmations.push(message); return options.confirm === true; },
    fetch: async (url, requestOptions) => { requests.push({ url, options: requestOptions }); return fetchImpl(url, requestOptions); },
    recordToast: message => toasts.push(message),
  });
  vm.runInContext(inline, context);
  const run = source => vm.runInContext(source, context);
  run("S.token='synthetic-session';S.user={email:'sales@example.invalid',role:'member',name:'Sales'};toast=recordToast;");
  return { run, element, context, requests, timers, toasts, confirmations, storage,
    init() { events.get('DOMContentLoaded')?.(); },
    seedListings(items) { context.syntheticListings = items; run('S.listings=syntheticListings;'); },
    seedChannels(item = channel()) {
      context.syntheticChannel = item;
      // Contact API contracts are independent from DOM rendering and the source
      // invalidation/snapshot contract, which is covered in dedicated tests.
      run("S.user.role='admin';localChannels=[normalizeChannel(syntheticChannel)];renderChannels=()=>{};if(typeof invalidateSourceViews==='function')invalidateSourceViews=()=>{};");
    },
    seedAnalysis(value = analysis()) { context.syntheticAnalysis = value; run('renderPriceTrends(syntheticAnalysis,{maxRows:250});'); },
  };
}

test('workspace exposes six primary sections and keeps extra tools secondary', () => {
  const primary = html.split('<div class="tabs">')[1].split('<details class="nav-tools">')[0];
  const navigation = [...primary.matchAll(/data-tab="([^"]+)"[^>]*>([^<]+)<\/button>/g)].map(match => [match[1], match[2]]);
  assert.deepEqual(navigation, [['feed', 'Offers'], ['requests', 'Buyer Requests'], ['matches', 'Matches'], ['market', 'Price Trends'], ['traders', 'Contacts'], ['channels', 'Sources']]);
  assert.match(primary, /data-tab="channels" hidden/);
  assert.match(html, /<summary>More tools<\/summary>/);
  assert.match(html, /id="trendStatus" role="status" aria-live="polite"/);
  assert.match(html, /No currency conversion, completed-sale assumption or forecast/);
});

test('Offers and Buyer Requests share a pane but never mix their feed modes', () => {
  const c = client();
  c.seedListings([listing(), listing({ id: 'buyer-request', type: 'WTB', model: 'Synthetic buyer request' })]);
  c.run("showTab('requests',document.querySelector('[data-tab=requests]'))");
  assert.equal(c.run('feedMode'), 'WTB');
  assert.equal(c.element('feedTitle').textContent, 'Buyer Requests');
  assert.match(c.element('feedDescription').textContent, /Budgets/);
  assert.match(c.element('feedList').innerHTML, /Synthetic buyer request/);
  assert.doesNotMatch(c.element('feedList').innerHTML, /Synthetic offer/);
  assert.equal(c.element('feedCount').textContent, '1 listings');
  assert.equal(c.element('pane-feed').classList.contains('active'), true);
  c.run("af='flagged';showTab('feed',document.querySelector('[data-tab=feed]'))");
  assert.equal(c.run('feedMode'), 'WTS');
  assert.equal(c.run('af'), 'all');
  assert.equal(c.element('feedTitle').textContent, 'Offers');
  assert.match(c.element('feedList').innerHTML, /Synthetic offer/);
  assert.doesNotMatch(c.element('feedList').innerHTML, /Synthetic buyer request/);
  assert.equal(c.requests.length, 0);
});

test('condition filters remain within the selected feed mode', () => {
  const c = client();
  c.seedListings([listing({ model: 'Used offer', condition: 'Used' }), listing({ type: 'WTB', model: 'Used request', condition: 'Used' }), listing({ type: 'WTB', model: 'New request' })]);
  c.run("showTab('requests');setF('used',document.getElementById('chip-2'))");
  assert.match(c.element('feedList').innerHTML, /Used request/);
  assert.doesNotMatch(c.element('feedList').innerHTML, /Used offer|New request/);
  assert.equal(c.element('feedCount').textContent, '1 listings');
});

test('unknown and refurbished conditions remain explicit and are never labeled Used', () => {
  const c = client();
  c.seedListings([listing({ condition: null }), listing({ id: 'refurb', condition: 'Refurbished' })]);
  c.run('renderFeed();renderDonut()');
  assert.match(c.element('feedList').innerHTML, /Condition unknown/);
  assert.match(c.element('feedList').innerHTML, /Refurbished/);
  assert.doesNotMatch(c.element('feedList').innerHTML, /class="tag used"|>Used</);
  assert.equal(c.element('pU').textContent, '0%');
  c.seedListings([listing(), listing({ condition: 'Used' }), listing({ condition: null }), listing({ condition: 'Refurbished' })]);
  c.run('renderDonut()');
  assert.equal(c.element('pN').textContent, '25%');
  assert.equal(c.element('pU').textContent, '25%');
  c.run("setF('used',document.getElementById('chip-2'))");
  assert.equal(c.element('feedCount').textContent, '1 listings');
});

test('source cards distinguish a selected personal contact from a group', () => {
  const c = client();
  c.context.contactListing = listing({ groupName: 'Known contact', source: { sourceType: 'contact', contactPhone: '+971500000001', chatId: '971500000001@s.whatsapp.net', providerMessageId: 'personal-message' } });
  const contact = c.run("matchSourceHtml(contactListing,'offer')");
  assert.match(contact, /Selected contact: Known contact/);
  assert.match(contact, /Contact chat ID: 971500000001@s\.whatsapp\.net/);
  assert.doesNotMatch(contact, /Group:|Group ID:/);
  c.context.groupListing = listing({ groupName: 'Known group', source: { sourceType: 'group', groupId: '120000000001@g.us', providerMessageId: 'group-message' } });
  const group = c.run("matchSourceHtml(groupListing,'demand')");
  assert.match(group, /Group: Known group/);
  assert.match(group, /Group ID: 120000000001@g\.us/);
  assert.doesNotMatch(group, /Selected contact:|Contact chat ID:/);
});

test('contact provenance supports top-level source type, phone fallback and escaped provider text', () => {
  const c = client();
  c.context.contactListing = listing({ sourceType: 'contact', source: { contactPhone: '+971500000001<img>', chatId: '<svg onload=unsafe()>', providerMessageId: '<script>unsafe()</script>' } });
  const rendered = c.run("matchSourceHtml(contactListing,'offer')");
  assert.match(rendered, /Selected contact: \+971500000001&lt;img&gt;/);
  assert.match(rendered, /Contact chat ID: &lt;svg/);
  assert.match(rendered, /Provider message ID: &lt;script&gt;/);
  assert.doesNotMatch(rendered, /<img|<svg|<script|Group ID:/);
});

test('price analysis sends separate exact fields in one authenticated bounded GET', async () => {
  const c = client(() => response({ analysis: analysis(), limits: { maxRows: 250 } }));
  const fields = { Model: '  Synthetic phone  ', Storage: ' 256GB ', Currency: ' usd ', Condition: 'Brand New', Region: 'UAE', Activation: 'not activated', Color: 'Black & Silver', Grade: 'A+', TradeClass: '14-day', GradingNamespace: 'Supplier system', SupplierGrade: 'Excellent' };
  for (const [suffix, value] of Object.entries(fields)) c.element('trend' + suffix).value = value;
  await c.run('loadPriceTrends()');
  assert.equal(c.requests.length, 1);
  const { url, options } = c.requests[0], parsed = new URL(url, 'https://example.invalid');
  assert.equal(parsed.pathname, '/api/price-trends');
  assert.deepEqual(Object.fromEntries(parsed.searchParams), { model: 'Synthetic phone', storage: '256GB', currency: 'USD', condition: 'Brand New', region: 'UAE', activation: 'not activated', color: 'Black & Silver', grade: 'A+', tradeClass: '14-day', gradingNamespace: 'Supplier system', supplierGrade: 'Excellent' });
  assert.equal(options.method, 'GET');
  assert.equal(options.headers.Authorization, 'Bearer synthetic-session');
  assert.equal(options.cache, 'no-store');
  assert.equal(options.body, undefined);
  assert.ok(options.signal instanceof AbortSignal);
  assert.ok(c.timers.some(timer => timer.milliseconds === 15000 && timer.cleared));
  assert.equal(c.run('P.busy'), false);
  assert.equal(c.element('trendLoadButton').disabled, false);
  assert.match(c.element('trendStatus').textContent, /at most 250 captured listings/);
});

test('quantity 50+ is optional, remembered locally and confined to the analysis request', async () => {
  const c = client(() => response({ analysis: analysis([]) }), { storage: { wa_trend_moq50: 'true' } });
  c.init();
  assert.equal(c.element('trendMOQ').checked, true);
  c.seedListings([listing({ qty: 2 })]);
  c.element('trendModel').value = 'Synthetic phone';
  await c.run('loadPriceTrends()');
  assert.equal(new URL(c.requests[0].url, 'https://example.invalid').searchParams.get('minQuantity'), '50');
  assert.equal(c.storage.get('wa_trend_moq50'), 'true');
  assert.equal(c.run('S.listings[0].qty'), 2);
  c.element('trendMOQ').checked = false;
  await c.run('loadPriceTrends()');
  assert.equal(new URL(c.requests[1].url, 'https://example.invalid').searchParams.has('minQuantity'), false);
  assert.equal(c.storage.get('wa_trend_moq50'), 'false');
  assert.equal(c.run('S.listings.length'), 1);
});

test('price analysis requires a model and performs no requests in demo or signed-out state', async () => {
  const c = client();
  await c.run('loadPriceTrends()');
  assert.match(c.element('trendStatus').textContent, /Enter a model first/);
  c.element('trendModel').value = 'Synthetic phone';
  c.run('S.isDemo=true;resetPriceTrends()');
  await c.run('loadPriceTrends()');
  assert.equal(c.element('trendLoadButton').disabled, true);
  assert.match(c.element('trendStatus').textContent, /No historical data is invented in demo mode/);
  c.run("S.isDemo=false;S.token='';resetPriceTrends()");
  await c.run('loadPriceTrends()');
  assert.equal(c.requests.length, 0);
  assert.equal(c.element('trendLoadButton').disabled, true);
});

test('price analysis prevents overlapping requests and releases the busy state', async () => {
  let release;
  const c = client(() => new Promise(resolve => { release = resolve; }));
  c.element('trendModel').value = 'Synthetic phone';
  const pending = c.run('loadPriceTrends()');
  assert.equal(c.run('P.busy'), true);
  assert.equal(c.element('trendLoadButton').disabled, true);
  await c.run('loadPriceTrends()');
  assert.equal(c.requests.length, 1);
  release(response({ analysis: analysis() }));
  await pending;
  assert.equal(c.run('P.busy'), false);
  assert.equal(c.run('P.controller'), null);
});

test('late trend response after session reset cannot restore prior account evidence', async () => {
  let release;
  const c = client(() => new Promise(resolve => { release = resolve; }));
  c.element('trendModel').value = 'Synthetic phone';
  const pending = c.run('loadPriceTrends()');
  c.run("sessionVersion++;S.token='';S.user=null;resetPriceTrends()");
  const statusAfterReset = c.element('trendStatus').textContent;
  assert.equal(c.requests[0].options.signal.aborted, true);
  release(response({ analysis: analysis() }));
  await pending;
  assert.equal(c.element('trendResults').innerHTML, '');
  assert.equal(c.element('trendStatus').textContent, statusAfterReset);
  assert.equal(c.element('trendLoadButton').disabled, true);
  assert.equal(c.run('P.busy'), false);
});

test('failed, invalid and timed-out trend requests leave no stale or invented results', async t => {
  for (const [name, fetchImpl] of [
    ['server failure', () => response({ error: 'History unavailable' }, 503)],
    ['invalid response', () => response({ analysis: { series: {} } })],
    ['timeout', (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => { const error = new Error('Aborted'); error.name = 'AbortError'; reject(error); }))],
  ]) {
    await t.test(name, async () => {
      const c = client(fetchImpl); c.seedAnalysis(); c.element('trendModel').value = 'Synthetic phone';
      const pending = c.run('loadPriceTrends()');
      if (name === 'timeout') c.timers.find(timer => timer.milliseconds === 15000).callback();
      await pending;
      assert.equal(c.element('trendResults').innerHTML, '');
      assert.match(c.element('trendStatus').textContent, /Price history could not be loaded/);
      assert.match(c.element('trendStatus').textContent, /No combined price or trend has been estimated/);
      if (name === 'timeout') assert.match(c.element('trendStatus').textContent, /timed out/);
      assert.equal(c.run('P.busy'), false);
      assert.equal(c.element('trendLoadButton').disabled, false);
    });
  }
});

test('price rendering preserves separate exact-spec server series and observed values', () => {
  const c = client();
  c.seedAnalysis(analysis([
    series({ trend: { status: 'observed_change', percentChange: 7.125 } }),
    series({ dimensions: { model: 'Synthetic phone', storage: '512GB', currency: 'AED', kind: 'buyer_budget' }, summary: { median: 999, min: 888, max: 1111, sampleCount: 9, uniqueSourceCount: 7, staleSampleCount: 2 }, buckets: [], evidence: [] }),
  ]));
  const rendered = c.element('trendResults').innerHTML;
  assert.equal((rendered.match(/class="trend-series"/g) || []).length, 2);
  for (const value of ['Storage: 256GB', 'Storage: 512GB', 'USD 111', 'USD 101', 'USD 121', 'AED 999', 'AED 888', 'AED 1,111', 'seller_ask', 'buyer_budget', '4 observations', '9 observations', '+7.125%']) assert.ok(rendered.includes(value), value);
  assert.match(rendered, /between completed periods\. This is not a forecast/);
  assert.match(rendered, /2026-10-08 · partial/);
  assert.match(rendered, /Listing listing-1 · Source reference source-ref-1/);
  assert.match(c.element('trendStatus').textContent, /4 observations included · 2 excluded · 1 duplicates removed/);
  assert.equal(c.requests.length, 0);
});

test('trend rendering never derives a change from differing buckets or absent server evidence', () => {
  const c = client();
  c.seedAnalysis(analysis([series()]));
  let rendered = c.element('trendResults').innerHTML;
  assert.match(rendered, /Trend unavailable: insufficient completed periods/);
  assert.doesNotMatch(rendered, /Observed median change:|\d+(?:\.\d+)?%|trend-up|trend-down/);
  c.seedAnalysis(analysis([series({ trend: { status: 'observed_change', percentChange: null } })]));
  assert.doesNotMatch(c.element('trendResults').innerHTML, /Observed median change:/);
  c.seedAnalysis(analysis([]));
  rendered = c.element('trendResults').innerHTML;
  assert.match(rendered, /No qualifying exact-spec history/);
  assert.match(rendered, /A trend cannot be inferred from missing evidence/);
  assert.doesNotMatch(rendered, /class="trend-series"|Observed median change:/);
});

test('trend rendering escapes dimensions, reasons, warnings, evidence and limitations', () => {
  const c = client();
  const hostile = '<img src=x onerror="unsafe()">';
  const a = analysis([series({ dimensions: { model: hostile, currency: '<svg>', kind: hostile, [hostile]: hostile }, trend: { status: 'unavailable', reasons: [hostile] }, warnings: [hostile], buckets: [{ start: '<script>', median: 11 }], evidence: [{ id: hostile, sourceRef: hostile, freshness: hostile, price: 11 }] })]);
  a.limitations = [hostile]; a.exclusions = [{ reasons: [hostile] }];
  c.seedAnalysis(a);
  const rendered = c.element('trendResults').innerHTML;
  assert.match(rendered, /&lt;img/);
  assert.match(rendered, /&lt;SVG&gt;/);
  assert.doesNotMatch(rendered, /<img|<svg|<script| onerror="unsafe/);
});

test('trend rendering bounds series and observation references without fabricating missing prices', () => {
  const c = client();
  const evidence = Array.from({ length: 35 }, (_, index) => ({ id: 'evidence-' + index, sourceRef: 'source-' + index }));
  c.seedAnalysis(analysis(Array.from({ length: 130 }, () => series({ dimensions: { model: 'Unknown quote', currency: null }, summary: {}, buckets: [], evidence }))));
  const rendered = c.element('trendResults').innerHTML;
  assert.equal((rendered.match(/class="trend-series"/g) || []).length, 128);
  assert.equal((rendered.match(/Showing the first 30 observation references\./g) || []).length, 128);
  assert.match(rendered, /Currency unknown Price unknown/);
  assert.match(rendered, /Listing evidence-29 /);
  assert.doesNotMatch(rendered, /Listing evidence-30 /);
});

test('contact normalization defaults OFF and preserves only explicit server authorization', () => {
  const c = client();
  for (const enabled of [undefined, null, false, 0, 1, 'true', 'false']) {
    c.context.syntheticContact = { id: 'contact-id', enabled };
    assert.equal(c.run('normalizeContact(syntheticContact).enabled'), false);
  }
  assert.equal(c.run("normalizeContact({id:'contact-id',enabled:true}).enabled"), true);
  assert.equal(c.run("normalizeContact({id:'contact-id'}).phone"), 'Unknown phone');
  assert.equal(c.run("normalizeContact({id:'contact-id'}).name"), '');
  assert.throws(() => c.run('normalizeContact({phone:"+971500000001"})'), /Invalid contact response/);
  c.context.syntheticChannel = { id: 'one', active: 'true', contacts: { ignoredKey: { id: 'contact-id', enabled: 'true' } } };
  assert.equal(c.run('normalizeChannel(syntheticChannel).contacts["contact-id"].enabled'), false);
  assert.equal(c.run('normalizeChannel(syntheticChannel).active'), false);
});

test('creating a known contact uses only phone/name and never enables it or activates its channel', async () => {
  const c = client((_url, options) => response(options.method === 'GET' ? [channel()] : { contact: channel().contacts['971500000001@s.whatsapp.net'] }));
  c.seedChannels();
  await c.run("addSourceContact('channel/one','  +971500000001  ','  Known seller  ')");
  assert.equal(c.requests.length, 2);
  assert.equal(c.requests[0].url, '/api/channels/channel%2Fone/contacts');
  assert.equal(c.requests[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(c.requests[0].options.body), { phone: '+971500000001', name: 'Known seller' });
  assert.equal(c.requests[0].options.headers.Authorization, 'Bearer synthetic-session');
  assert.equal(c.requests[1].url, '/api/channels');
  assert.equal(c.requests[1].options.method, 'GET');
  assert.equal(c.run('localChannels[0].active'), false);
  assert.equal(c.run('localChannels[0].contacts["971500000001@s.whatsapp.net"].enabled'), false);
  assert.match(c.element('channelsStatus').textContent, /Contact added OFF/);
  assert.match(c.element('channelsStatus').textContent, /separate choices/);
});

test('contact phone validation requires an explicit international plus number and bounded label', async t => {
  for (const phone of ['', '971500000001', '0044150000000', '+0123456789', '+1234567', '+1234567890123456', '+971 500000001', '+971-500000001', '+971500000001@s.whatsapp.net', 'Known seller']) {
    await t.test(JSON.stringify(phone), async () => {
      const c = client(); c.seedChannels(); c.context.phone = phone;
      await c.run("addSourceContact('channel/one',phone,'Known seller')");
      assert.equal(c.requests.length, 0);
      assert.match(c.element('channelsStatus').textContent, /Use \+ followed by the country code/);
    });
  }
  const c = client(); c.seedChannels();
  await c.run("addSourceContact('channel/one','+971500000001','x'.repeat(101))");
  assert.equal(c.requests.length, 0);
  assert.match(c.element('channelsStatus').textContent, /at most 100 characters/);
});

test('contact toggle PATCH is version-free, exact and leaves other selections untouched', async t => {
  for (const enabled of [true, false]) {
    await t.test(String(enabled), async () => {
      const c = client(() => response({ ok: true }));
      const item = channel({ active: true, groups: { group1: { id: 'group1', enabled: true } } });
      item.contacts['971500000001@s.whatsapp.net'].enabled = !enabled;
      item.contacts.other = { id: 'other', phone: '+971500000002', enabled: true };
      c.seedChannels(item);
      await c.run(`toggleSourceContact('channel/one','971500000001@s.whatsapp.net',${enabled})`);
      assert.equal(c.requests.length, 1);
      assert.equal(c.requests[0].url, '/api/channels/channel%2Fone/contacts/971500000001%40s.whatsapp.net');
      assert.equal(c.requests[0].options.method, 'PATCH');
      assert.deepEqual(JSON.parse(c.requests[0].options.body), { enabled });
      assert.equal(c.run('localChannels[0].contacts["971500000001@s.whatsapp.net"].enabled'), enabled);
      assert.equal(c.run('localChannels[0].contacts.other.enabled'), true);
      assert.equal(c.run('localChannels[0].groups.group1.enabled'), true);
      assert.equal(c.run('localChannels[0].active'), true);
    });
  }
});

test('invalid contact toggles and failed PATCH do not change local consent', async () => {
  const c = client(() => response({ error: 'Selection was not saved' }, 503)); c.seedChannels();
  for (const expression of ["toggleSourceContact('missing','971500000001@s.whatsapp.net',true)", "toggleSourceContact('channel/one','missing',true)", "toggleSourceContact('channel/one','971500000001@s.whatsapp.net','true')"]) await c.run(expression);
  assert.equal(c.requests.length, 0);
  await c.run("toggleSourceContact('channel/one','971500000001@s.whatsapp.net',true)");
  assert.equal(c.requests.length, 1);
  assert.equal(c.run('localChannels[0].contacts["971500000001@s.whatsapp.net"].enabled'), false);
  assert.match(c.element('channelsStatus').textContent, /Selection was not saved/);
});

test('contact removal warns about revocation and makes no request when confirmation is declined', async () => {
  const c = client(); c.seedChannels();
  await c.run("removeSourceContact('channel/one','971500000001@s.whatsapp.net')");
  assert.equal(c.confirmations.length, 1);
  assert.match(c.confirmations[0], /Known seller/);
  assert.match(c.confirmations[0], /revoke this source/);
  assert.match(c.confirmations[0], /cannot be added again/);
  assert.equal(c.requests.length, 0);
  assert.equal(c.run('Object.hasOwn(localChannels[0].contacts,"971500000001@s.whatsapp.net")'), true);
});

test('confirmed contact removal sends a body-free DELETE to only the selected contact', async () => {
  const c = client(() => response({ ok: true }), { confirm: true }); c.seedChannels();
  await c.run("removeSourceContact('channel/one','971500000001@s.whatsapp.net')");
  assert.equal(c.confirmations.length, 1);
  assert.equal(c.requests.length, 1);
  assert.equal(c.requests[0].url, '/api/channels/channel%2Fone/contacts/971500000001%40s.whatsapp.net');
  assert.equal(c.requests[0].options.method, 'DELETE');
  assert.equal(c.requests[0].options.body, undefined);
  assert.equal(c.run('Object.hasOwn(localChannels[0].contacts,"971500000001@s.whatsapp.net")'), false);
  assert.equal(c.run('localChannels.length'), 1);
  assert.match(c.element('channelsStatus').textContent, /removed and revoked/);
});

test('source contact create, toggle and removal are unavailable to members and demo users', async t => {
  for (const [name, setup] of [['member', "S.user.role='member'"], ['missing user', 'S.user=null'], ['demo admin', 'S.isDemo=true'], ['signed out', "S.token=''"], ['operation busy', 'channelsBusy=true']]) {
    await t.test(name, async () => {
      const c = client(); c.seedChannels(); c.run(setup);
      await c.run("addSourceContact('channel/one','+971500000001','Known seller')");
      await c.run("toggleSourceContact('channel/one','971500000001@s.whatsapp.net',true)");
      await c.run("removeSourceContact('channel/one','971500000001@s.whatsapp.net')");
      assert.equal(c.requests.length, 0);
      assert.equal(c.run('localChannels[0].contacts["971500000001@s.whatsapp.net"].enabled'), false);
      if (name !== 'signed out') assert.equal(c.confirmations.length, 0);
    });
  }
});

test('non-admin Sources navigation is blocked before changing the active pane', () => {
  const c = client();
  c.element('pane-feed').classList.add('active');
  c.run("showTab('channels',document.querySelector('[data-tab=channels]'))");
  assert.equal(c.element('pane-feed').classList.contains('active'), true);
  assert.equal(c.element('pane-channels').classList.contains('active'), false);
  assert.deepEqual(c.toasts, ['Channel settings require an administrator']);
  assert.equal(c.requests.length, 0);
});
