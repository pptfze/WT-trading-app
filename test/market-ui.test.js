'use strict';
// Dependency-free client contract tests with a VM and a minimal DOM stub.
// Fetch and XLSX are synthetic: this is not browser, visual, or live-service QA.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const inline = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(x => x[1]).join('\n');
function response(body, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => body }; }
function payload(matches = []) { return { matches, limits: { freshnessHours: 48, inventoryReservation: false } }; }
function listing(overrides = {}) {
  return { id: 'offer-1', version: 7, availability: 'active', model: 'Synthetic phone', type: 'WTS', price: 111, currency: 'USD', qty: 2, condition: 'Brand New', sender: 'seller', ...overrides };
}
function lead(overrides = {}) {
  return { id: 'lead-1', version: 3, status: 'claimed', assignedTo: 'sales@example.invalid', flags: [], notes: [], updatedAt: '2026-10-12T12:00:00.000Z',
    offer: listing(), demand: listing({ id: 'demand-1', version: 9, type: 'WTB', price: 130, sender: 'buyer' }), ...overrides };
}
function client(fetchImpl = async () => { throw new Error('Unexpected request'); }) {
  const elements = new Map(), requests = [], exports = [], toasts = [];
  function element(id) {
    if (!elements.has(id)) elements.set(id, { value: id === 'matchFilter' ? 'all' : '', innerHTML: '', textContent: '', disabled: false, style: {}, attributes: {}, listeners: {}, classList: { add() {}, remove() {} }, setAttribute(k, v) { this.attributes[k] = v; }, addEventListener(k, v) { this.listeners[k] = v; }, remove() {} });
    return elements.get(id);
  }
  const XLSX = {
    utils: {
      book_new: () => ({ sheets: [] }),
      aoa_to_sheet: rows => ({ rows: Array.from(rows, row => Array.from(row)) }),
      book_append_sheet: (book, sheet, name) => book.sheets.push({ name, ...sheet }),
    },
    writeFile: (book, filename) => exports.push({ book, filename }),
  };
  const context = vm.createContext({
    document: { getElementById: element, querySelectorAll: () => [], querySelector: () => element('selector'), createElement: () => ({ remove() {} }), body: { appendChild: el => toasts.push(el.textContent) } },
    window: { addEventListener() {}, XLSX }, XLSX,
    localStorage: { getItem: () => null, removeItem() {} },
    setTimeout: (...args) => { const timer = setTimeout(...args); timer.unref(); return timer; },
    clearTimeout, setInterval, clearInterval, AbortController,
    fetch: async (url, options) => { requests.push({ url, options }); return fetchImpl(url, options); },
  });
  vm.runInContext(inline, context);
  const run = source => vm.runInContext(source, context);
  run("S.token='synthetic-session';S.user={email:'sales@example.invalid',role:'member',name:'Sales'};");
  return { run, element, requests, exports, toasts, context,
    seedListings(items) { context.syntheticListings = items; run('S.listings=syntheticListings;'); },
    seed(match = lead()) { context.syntheticMatch = match; run('M.items=[syntheticMatch];M.verified=true;M.loadedAt=new Date();renderMatches();'); },
  };
}

test('money uses explicit currency codes and preserves a finite zero price', () => {
  const c = client();
  assert.equal(c.run("matchMoney(111,' usd ')"), 'USD 111');
  assert.equal(c.run("matchMoney(222,'AED')"), 'AED 222');
  assert.equal(c.run("matchMoney(0,'EUR')"), 'EUR 0');
  assert.equal(c.run('matchMoney(0,null)'), 'Currency unknown 0');
  for (const currency of ['null', 'undefined', "''", "'  '"]) {
    assert.equal(c.run(`matchMoney(333,${currency})`), 'Currency unknown 333');
  }
  for (const price of ['null', 'undefined', 'NaN', 'Infinity', "'0'"]) {
    assert.equal(c.run(`matchMoney(${price},'USD')`), 'USD Price unknown');
  }
  assert.equal(c.run('matchMoney(null,null)'), 'Currency unknown Price unknown');
});

for (const [name, render, target] of [
  ['feed', 'renderFeed()', 'feedList'],
  ['export rows', "renderExpRows('wtsRows',S.listings)", 'wtsRows'],
  ['watchlist matches', "S.watchlist=['synthetic'];renderWatchlist()", 'watchMatches'],
]) {
  test(`${name} keeps USD, AED and unknown currencies separate without guessed dollar signs`, () => {
    const c = client();
    c.seedListings([
      listing(), listing({ id: 'aed', currency: 'AED', price: 222 }),
      listing({ id: 'unknown', currency: null, price: 333 }),
      listing({ id: 'zero', currency: 'USD', price: 0 }),
      listing({ id: 'no-price', currency: 'AED', price: null }),
      listing({ id: 'no-quote', currency: null, price: null }),
    ]);
    c.run(render);
    const rendered = c.element(target).innerHTML;
    for (const quote of ['USD 111', 'AED 222', 'Currency unknown 333', 'USD 0', 'AED Price unknown', 'Currency unknown Price unknown']) assert.ok(rendered.includes(quote), quote);
    assert.doesNotMatch(rendered, /\$/);
    assert.equal(c.requests.length, 0);
  });

  test(`${name} escapes currency text instead of creating markup`, () => {
    const c = client(); c.seedListings([listing({ currency: '<img src=x>' })]); c.run(render);
    assert.doesNotMatch(c.element(target).innerHTML, /<img/i);
    assert.match(c.element(target).innerHTML, /&lt;IMG SRC=X&gt; 111/);
  });
}

test('overall KPIs and market activity never read prices to pool incompatible listings', () => {
  const c = client();
  const items = [listing(), listing({ type: 'WTB', currency: 'AED' }), listing({ currency: null })];
  for (const item of items) Object.defineProperty(item, 'price', { get() { throw new Error('A pooled price was read'); } });
  c.seedListings(items);
  assert.doesNotThrow(() => c.run('renderKPIs();renderMarket()'));
  assert.equal(c.element('kA').textContent, 'Unavailable');
  assert.equal(c.element('kT').textContent, 3);
  assert.equal(c.element('kS').textContent, 2);
  assert.equal(c.element('kB').textContent, 1);
  assert.doesNotMatch(c.element('priceList').innerHTML + c.element('priceList').textContent, /\$|(?:USD|AED)\s+\d|trend-up|trend-down/);
});

test('report workbook provides count-only Listing Activity with no aggregate price or signal columns', () => {
  const c = client();
  c.seedListings([
    listing(), listing({ id: 'aed', currency: 'AED', price: 777 }),
    listing({ id: 'buyer', type: 'WTB', currency: null, price: null }),
    listing({ id: 'zero', model: 'Other phone', price: 0, currency: null }),
  ]);
  c.run("renderExport();exportXLSX('report')");
  assert.equal(c.exports.length, 1);
  assert.match(c.exports[0].filename, /^WA_Trading_All_\d{4}-\d{2}-\d{2}\.xlsx$/);
  const sheets = c.exports[0].book.sheets;
  assert.deepEqual(sheets.map(s => s.name), ['WTS Sellers', 'WTB Buyers', 'Listing Activity']);
  const activity = sheets.find(s => s.name === 'Listing Activity');
  assert.deepEqual(activity.rows[0], ['Model', 'WTS listing count', 'WTB listing count', 'Note']);
  assert.deepEqual(activity.rows.slice(1).map(r => r.slice(0, 3)), [['Synthetic phone', 2, 1], ['Other phone', 1, 0]]);
  assert.ok(activity.rows.slice(1).every(r => /counts only/i.test(r[3])));
  assert.doesNotMatch(activity.rows[0].join(' '), /price|average|mean|min|max|margin|spread|signal/i);
  assert.ok(activity.rows.every(row => !row.includes(111) && !row.includes(777)));
  const sellers = sheets.find(s => s.name === 'WTS Sellers').rows;
  assert.deepEqual(sellers[3].slice(11, 13), [0, 'Currency unknown']);
  const buyers = sheets.find(s => s.name === 'WTB Buyers').rows;
  assert.deepEqual(buyers[1].slice(10, 12), ['Price unknown', 'Currency unknown']);
  assert.equal(c.requests.length, 0);
});

test('manual calculator remains explicitly USD and independent from listing prices', () => {
  const c = client();
  assert.match(html, /Buy Price \(USD\)/);
  assert.match(html, /Sell Price \(USD\)/);
  assert.match(html, /Shipping Total \(USD\)/);
  c.seedListings([listing({ price: 100000, currency: 'AED' })]);
  for (const [id, value] of Object.entries({ cBuy: '100', cSell: '150', cQty: '2', cShip: '20', cDuty: '0', cOther: '0' })) c.element(id).value = value;
  c.run('calcMargin()');
  assert.equal(c.element('rCost').textContent, '$110.00');
  assert.equal(c.element('rProfit').textContent, '+$40.00');
  assert.equal(c.element('rTotal').textContent, '+$80.00');
  assert.equal(c.requests.length, 0);
});

test('source controls require an assigned owner or administrator and a listing version', () => {
  const c = client(); c.seed();
  assert.equal((c.element('matchesList').innerHTML.match(/data-match-action="availability"/g) || []).length, 2);
  assert.match(c.element('matchesList').innerHTML, /Changes this source listing for all linked leads/);
  c.seed(lead({ assignedTo: 'other@example.invalid' }));
  assert.doesNotMatch(c.element('matchesList').innerHTML, /data-match-action="availability"/);
  c.run("S.user.role='admin';renderMatches()");
  assert.equal((c.element('matchesList').innerHTML.match(/data-match-action="availability"/g) || []).length, 2);
  c.seed(lead({ assignedTo: null, status: 'new' }));
  assert.doesNotMatch(c.element('matchesList').innerHTML, /data-match-action="availability"/);
  c.seed(lead({ offer: listing({ version: undefined }) }));
  assert.doesNotMatch(c.element('matchesList').innerHTML, /data-source-side="offer"/);
  assert.match(c.element('matchesList').innerHTML, /data-source-side="demand"/);
});

test('unauthorized, stale, invalid and unchanged availability updates make no requests', async t => {
  const cases = [
    ['another owner', "M.items[0].assignedTo='other@example.invalid'"],
    ['unassigned administrator', "M.items[0].assignedTo=null;S.user.role='admin'"],
    ['missing source version', 'delete M.items[0].offer.version'],
    ['string source version', "M.items[0].offer.version='7'"],
    ['fractional source version', 'M.items[0].offer.version=1.5'],
    ['unsafe source version', 'M.items[0].offer.version=Number.MAX_SAFE_INTEGER+1'],
    ['unverified view', 'M.verified=false'],
    ['demo mode', 'S.isDemo=true'],
    ['signed out', "S.token=''"],
    ['missing user', 'S.user=null'],
    ['missing match', '', 'missing'],
    ['invalid side', '', 'lead-1', 'seller'],
    ['invalid availability', '', 'lead-1', 'offer', 'reserved'],
    ['unchanged availability', '', 'lead-1', 'offer', 'active'],
  ];
  for (const [name, setup, id = 'lead-1', side = 'offer', availability = 'unavailable'] of cases) {
    await t.test(name, async () => {
      const c = client(); c.seed(); if (setup) c.run(setup);
      await c.run(`updateSourceAvailability(${JSON.stringify(id)},${JSON.stringify(side)},${JSON.stringify(availability)})`);
      assert.equal(c.requests.length, 0);
      assert.equal(c.run('M.busy'), false);
    });
  }
});

test('availability PATCH sends the source version and refreshes authoritative server matches', async t => {
  for (const availability of ['active', 'unavailable', 'fulfilled']) {
    await t.test(availability, async () => {
      const original = lead({ offer: listing({ id: 'offer/with space', availability: availability === 'active' ? 'unavailable' : 'active' }) });
      const c = client((url, options) => response(options.method === 'PATCH' ? { listing: { ...original.offer, version: 8, availability } } : payload([])));
      c.seed(original);
      await c.run(`updateSourceAvailability('lead-1','offer','${availability}')`);
      assert.equal(c.requests.length, 2);
      assert.equal(c.requests[0].url, '/api/listings/offer%2Fwith%20space');
      assert.equal(c.requests[0].options.method, 'PATCH');
      assert.deepEqual(JSON.parse(c.requests[0].options.body), { version: 7, availability });
      assert.equal(c.requests[0].options.headers.Authorization, 'Bearer synthetic-session');
      assert.equal(c.requests[1].url, '/api/matches?limit=100');
      assert.equal(c.requests[1].options.method, 'GET');
      assert.equal(c.run('M.items.length'), 0);
      assert.equal(c.run('M.busy'), false);
      assert.equal(c.run('M.verified'), true);
      assert.match(c.element('matchesStatus').textContent, /Source availability saved/);
      assert.match(c.element('matchesStatus').textContent, /No inventory was reserved/);
    });
  }
});

test('administrator can change the demand side using its own version', async () => {
  const c = client((url, options) => response(options.method === 'PATCH' ? {} : payload()));
  c.seed(lead({ assignedTo: 'other@example.invalid' })); c.run("S.user.role='admin'");
  await c.run("updateSourceAvailability('lead-1','demand','fulfilled')");
  assert.equal(c.requests.length, 2);
  assert.equal(c.requests[0].url, '/api/listings/demand-1');
  assert.deepEqual(JSON.parse(c.requests[0].options.body), { version: 9, availability: 'fulfilled' });
});

test('availability mutation shares the busy lock with repeat clicks, lead updates and refresh', async () => {
  let release;
  const c = client((url, options) => options.method === 'PATCH' ? new Promise(resolve => { release = resolve; }) : response(payload()));
  c.seed(); c.run("M.drafts.set('lead-1',{status:'contacted',note:'Do not send while busy'})");
  const pending = c.run("updateSourceAvailability('lead-1','offer','unavailable')");
  assert.equal(c.run('M.busy'), true);
  assert.equal(c.element('refreshMatchesButton').disabled, true);
  assert.match(c.element('matchesList').innerHTML, /data-match-action="availability" data-source-side="offer" disabled/);
  await c.run("updateSourceAvailability('lead-1','offer','unavailable')");
  await c.run("updateSourceAvailability('lead-1','demand','fulfilled')");
  await c.run("updateMatch('lead-1','save')");
  await c.run('refreshMatches()');
  assert.equal(c.requests.length, 1);
  release(response({})); await pending;
  assert.equal(c.requests.length, 2);
  assert.equal(c.run('M.busy'), false);
});

test('409 availability conflict refreshes latest permissions and never retries PATCH', async () => {
  const latest = lead({ assignedTo: 'other@example.invalid', offer: listing({ version: 8, availability: 'fulfilled' }) });
  const c = client((url, options) => options.method === 'PATCH' ? response({ error: 'Version changed' }, 409) : response(payload([latest])));
  c.seed(); await c.run("updateSourceAvailability('lead-1','offer','unavailable')");
  assert.equal(c.requests.length, 2);
  assert.equal(c.requests.filter(r => r.options.method === 'PATCH').length, 1);
  assert.equal(c.run('M.items[0].offer.version'), 8);
  assert.equal(c.run('M.items[0].offer.availability'), 'fulfilled');
  assert.match(c.element('matchesStatus').textContent, /source listing changed/i);
  assert.match(c.element('matchesStatus').textContent, /update was not applied/);
  assert.match(c.element('matchesStatus').textContent, /Latest available leads/);
  assert.doesNotMatch(c.element('matchesList').innerHTML, /data-match-action="availability"/);
  await c.run("updateSourceAvailability('lead-1','offer','unavailable')");
  assert.equal(c.requests.length, 2);
});

test('availability conflict followed by failed refresh disables stale mutations', async () => {
  const c = client((url, options) => response({ error: 'Synthetic failure' }, options.method === 'PATCH' ? 409 : 503));
  c.seed(); await c.run("updateSourceAvailability('lead-1','offer','unavailable')");
  assert.equal(c.requests.length, 2);
  assert.equal(c.run('M.verified'), false);
  assert.equal(c.run('M.busy'), false);
  assert.match(c.element('matchesStatus').textContent, /Refresh failed; editing is disabled/);
  assert.match(c.element('matchesList').innerHTML, /data-match-action="availability" data-source-side="offer" disabled/);
  await c.run("updateSourceAvailability('lead-1','offer','fulfilled')");
  assert.equal(c.requests.length, 2);
});

test('late availability completion cannot refresh or restore a changed session', async () => {
  let release;
  const c = client(() => new Promise(resolve => { release = resolve; }));
  c.seed(); const pending = c.run("updateSourceAvailability('lead-1','offer','unavailable')");
  c.run("sessionVersion++;S.token='';S.user=null;resetMatches()");
  release(response({})); await pending;
  assert.equal(c.requests.length, 1);
  assert.equal(c.run('M.items.length'), 0);
  assert.equal(c.run('M.verified'), false);
  assert.equal(c.run('M.busy'), false);
  assert.doesNotMatch(c.element('matchesStatus').textContent, /availability saved/i);
});
