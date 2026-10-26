'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzePriceTrends: analyze, observationsFromListings: adapt } = require('../lib/price-trends');
const options = { asOf: '2026-10-12T12:00:00Z' };

function sample(id, changes = {}) {
  return {
    id, model: 'iphone 18 pro max', storage: '256GB', condition: 'Brand New',
    grade: 'not_applicable', gradingMethod: 'not_applicable', regionalVariant: 'hk',
    tradeClass: 'not_applicable', supplierGrade: 'not_applicable', gradingNamespace: 'not_applicable',
    color: 'burgundy', activationStatus: 'active', sim: 'dual physical', ram: null,
    market: 'Hong Kong', shippingTerms: 'ex works', currency: 'USD', kind: 'asking_price',
    priceUnit: 'unit', price: 100, quantity: 50, observedAt: '2026-10-06T09:00:00Z',
    source: { id: `supplier-${id}`, isForwarded: false }, ...changes,
  };
}

function sufficient() {
  return [
    sample('p1', { observedAt: '2026-09-29T09:00:00Z', price: 90 }),
    sample('p2', { observedAt: '2026-09-30T09:00:00Z', price: 100 }),
    sample('p3', { observedAt: '2026-10-01T09:00:00Z', price: 110 }),
    sample('c1', { observedAt: '2026-10-06T09:00:00Z', price: 120 }),
    sample('c2', { observedAt: '2026-10-07T09:00:00Z', price: 130 }),
    sample('c3', { observedAt: '2026-10-08T09:00:00Z', price: 140 }),
  ];
}

function tested(grade, method = 'drfone') {
  return {condition: 'Used', grade, gradingMethod: method, tradeClass: 'tested', supplierGrade: null, gradingNamespace: null};
}

function asIs(supplierGrade, gradingNamespace = 'verizon') {
  return {condition: 'Used', grade: null, gradingMethod: 'as_is', tradeClass: 'as_is', supplierGrade, gradingNamespace};
}

test('calculates dated medians, range, counts and evidence-backed observed change', () => {
  const result = analyze(sufficient(), options), series = result.series[0];
  assert.deepEqual(result.counts, { input: 6, included: 6, duplicatesRemoved: 0, excluded: 0 });
  assert.equal(series.summary.median, 115);
  assert.equal(series.summary.min, 90);
  assert.equal(series.summary.max, 140);
  assert.equal(series.summary.sampleCount, 6);
  assert.equal(series.summary.uniqueSourceCount, 6);
  assert.equal(series.trend.status, 'observed_change');
  assert.equal(series.trend.delta, 30);
  assert.equal(series.trend.percentChange, 30);
  assert.equal(series.trend.direction, 'up');
  assert.equal(series.trend.forecast, false);
  assert.equal(series.trend.evidenceIds.length, 6);
  assert.equal(series.evidence.length, 6);
  assert.ok(series.evidence.every(e => e.sourceRef.length === 64));
  assert.equal(JSON.stringify(result).includes('supplier-p1'), false);
});

test('never pools exact specs, currencies, grade namespaces, markets or price kinds', () => {
  const modifications = [
    {}, { model: 'iphone 18 pro' }, { storage: '512GB' }, { currency: 'AED' },
    { regionalVariant: 'japan' }, { color: 'black' }, { activationStatus: 'non_active' },
    { sim: 'esim' }, { ram: '8GB' }, { market: 'Dubai' }, { shippingTerms: 'delivered' },
    { batteryHealth: 99 }, { kind: 'buyer_budget' },
    tested('A'), tested('A+'), tested('B+'), tested('B'), tested('C'), tested('A', 'cosmetic'),
    asIs('DNA'), asIs('DNB'), asIs('DNC'), asIs('DND'), asIs('DNA', 'another_carrier'),
    {...tested('A'), condition: 'Refurbished'},
    { kind: 'completed_deal', verified: true, verificationRef: 'deal:123' },
  ];
  const result = analyze(modifications.map((v, i) => sample(String(i), v)), options);
  assert.equal(result.series.length, modifications.length);
  assert.ok(result.series.every(s => s.trend.status === 'insufficient_data'));
});

test('rejects missing critical specs without filling unknowns from other records', () => {
  const fields = ['model', 'storage', 'condition', 'grade', 'gradingMethod', 'regionalVariant', 'color', 'activationStatus', 'currency', 'priceUnit'];
  const result = analyze(fields.map((field, i) => sample(String(i), { [field]: null })), options);
  assert.equal(result.series.length, 0);
  assert.equal(result.exclusions.length, fields.length);
});

test('unknown optional specs are visible and never mixed with known values', () => {
  const result = analyze([sample('unknown', { sim: null }), sample('known')], options);
  assert.equal(result.series.length, 2);
  assert.ok(result.series.find(s => s.dimensions.sim === null).warnings.includes('unknown_sim'));
});

test('unknown original source/date for a forwarded offer is excluded', () => {
  const result = analyze([sample('forward', { source: { id: 'forwarder', isForwarded: true, contentFingerprint: 'hash' } })], options);
  assert.equal(result.counts.included, 0);
  assert.ok(result.exclusions[0].reasons.includes('forward_missing_original_provenance'));
});

test('deduplicates verifiable forwarded offers while retaining duplicate evidence IDs', () => {
  const base = sample('original', { source: { id: 'origin', isForwarded: false, originalOfferId: 'offer-1', contentFingerprint: 'hash' } });
  const forward = { ...base, id: 'forward', source: { ...base.source, isForwarded: true, originalSourceId: 'origin', originalObservedAt: base.observedAt } };
  const result = analyze([base, forward], options);
  assert.equal(result.counts.included, 1);
  assert.equal(result.counts.duplicatesRemoved, 1);
  assert.equal(result.series[0].summary.uniqueSourceCount, 1);
  assert.deepEqual(result.series[0].evidence[0].duplicateIds, ['original']);
});

test('provider retries deduplicate by provider, account, message and line index', () => {
  const source = { id: 'supplier', isForwarded: false, provider: 'whapi', accountId: 'channel-1', providerMessageId: 'msg-1', lineIndex: 0 };
  const result = analyze([sample('a', { source }), sample('b', { source })], options);
  assert.equal(result.counts.included, 1);
  assert.equal(result.counts.duplicatesRemoved, 1);
});

test('different items on the same provider message survive', () => {
  const source = { id: 'supplier', isForwarded: false, provider: 'whapi', accountId: 'channel-1', providerMessageId: 'msg-1', lineIndex: 0, contentFingerprint: 'whole-message-hash' };
  const result = analyze([sample('a', { source }), sample('b', { storage: '512GB', source: { ...source, lineIndex: 1 } })], options);
  assert.equal(result.counts.included, 2);
  assert.equal(result.series.length, 2);
});

test('conflicting reused identities are excluded, not resolved by latest arrival', () => {
  const source = { id: 'supplier', isForwarded: false, provider: 'whapi', accountId: 'channel', providerMessageId: 'msg', lineIndex: 0 };
  const values = [sample('a', { source }), sample('b', { source, price: 500 })];
  for (const input of [values, values.slice().reverse()]) {
    const result = analyze(input, options);
    assert.equal(result.counts.included, 0);
    assert.ok(result.exclusions.every(e => e.reasons.includes('conflicting_duplicate_identity')));
  }
});

test('duplicate content with conflicting origin or date is conservatively excluded', () => {
  const a = sample('a', { source: { id: 'a', isForwarded: false, contentFingerprint: 'copied-message' } });
  const b = sample('b', { source: { id: 'b', isForwarded: false, contentFingerprint: 'copied-message' } });
  const result = analyze([a, b], options);
  assert.equal(result.counts.included, 0);
  assert.equal(result.counts.excluded, 2);
});

test('duplicate bridges are order independent', () => {
  const source = { id: 's', isForwarded: false, provider: 'whapi', accountId: 'c', providerMessageId: 'm', lineIndex: 0 };
  const a = sample('a', { source }), b = sample('b', { source: { ...source, originalOfferId: 'o' } }), c = sample('c', { source: { id: 's', isForwarded: false, originalOfferId: 'o' } });
  for (const values of [[a,b,c], [c,a,b], [b,c,a]]) assert.equal(analyze(values, options).counts.duplicatesRemoved, 2);
});

test('a single source cannot produce a trend by repeated offers', () => {
  const values = sufficient().map(v => ({ ...v, source: { id: 'only-supplier', isForwarded: false } }));
  const trend = analyze(values, options).series[0].trend;
  assert.equal(trend.status, 'insufficient_data');
  assert.ok(trend.reasons.includes('insufficient_unique_sources'));
  assert.equal(trend.percentChange, null);
});

test('requires minimum samples and cannot configure below conservative floors', () => {
  assert.equal(analyze(sufficient().slice(1), options).series[0].trend.status, 'insufficient_data');
  assert.throws(() => analyze([], { ...options, minSamples: 1 }), /conservative/);
  assert.throws(() => analyze([], { ...options, minSources: 1 }), /conservative/);
});

test('partial current buckets are visible but excluded from the change calculation', () => {
  const result = analyze([...sufficient(), sample('current', { observedAt: '2026-10-12T10:00:00Z', price: 10000 })], options);
  const series = result.series[0];
  assert.equal(series.trend.delta, 30);
  assert.equal(series.buckets.at(-1).complete, false);
  assert.equal(series.buckets.at(-1).median, 10000);
});

test('gaps in latest complete buckets do not create a trend from older periods', () => {
  const values = sufficient().filter(v => v.id.startsWith('p'));
  const trend = analyze(values, options).series[0].trend;
  assert.equal(trend.status, 'insufficient_data');
  assert.equal(trend.latestBucketStart, '2026-10-05T00:00:00.000Z');
});

test('fresh/stale evidence flags and freshness threshold are explicit', () => {
  const series = analyze(sufficient(), { ...options, freshForDays: 2 }).series[0];
  assert.equal(series.summary.staleSampleCount, 6);
  assert.ok(series.evidence.every(e => e.freshness === 'stale'));
  assert.ok(series.trend.reasons.includes('insufficient_fresh_latest_samples'));
});

test('rejects malformed, future, undated and out-of-window data', () => {
  const changes = [{price: 0}, {price: -1}, {price: Infinity}, {price: '100'}, {quantity: 0}, {observedAt: '2026-10-13T00:00:00Z'}, {observedAt: '2026-10-01'}, {observedAt: '2026-02-30T00:00:00Z'}, {observedAt: '2026-01-01T00:00:00Z'}, {currency: '$'}, {batteryHealth: 101}, {priceUnit: 'lot'}];
  const result = analyze(changes.map((v, i) => sample(String(i), v)), options);
  assert.equal(result.counts.included, 0);
  assert.equal(result.counts.excluded, changes.length);
});

test('requires explicit verification for completed deal prices', () => {
  const values = [sample('bad', {kind: 'completed_deal'}), sample('good', {kind: 'completed_deal', verified: true, verificationRef: 'transaction:123'})];
  const result = analyze(values, options);
  assert.equal(result.counts.included, 1);
  assert.equal(result.series[0].evidence[0].verificationRef, 'transaction:123');
});

test('50-piece quantity filter excludes missing and small lots without weighting median', () => {
  const values = [sample('a', {quantity: 49}), sample('b', {quantity: null}), sample('c', {quantity: 50}), sample('d', {quantity: 1000, price: 200})];
  const result = analyze(values, {...options, minQuantity: 50});
  assert.equal(result.counts.included, 2);
  assert.equal(result.series[0].summary.median, 150);
});

test('canonical whitespace/case normalize, but no semantic aliases or grade mappings are guessed', () => {
  const a = sample('a'), b = sample('b', {model: '  IPHONE   18 PRO MAX ', currency: 'usd'}), c = sample('c', {regionalVariant: 'hong kong'});
  assert.equal(analyze([a,b,c], options).series.length, 2);
});

test('day buckets use UTC boundaries including offset timestamps', () => {
  const result = analyze([sample('a', {observedAt: '2026-10-05T01:00:00+04:00'})], {...options, bucket: 'day'});
  const populated = result.series[0].buckets.filter(b => b.sampleCount);
  assert.equal(populated[0].start, '2026-10-04T00:00:00.000Z');
});

test('empty data stays empty; no AI-generated numbers and no hidden clock', () => {
  assert.deepEqual(analyze([], options).series, []);
  assert.throws(() => analyze([]), /asOf/);
  assert.throws(() => analyze([], {asOf: '2026-02-30T00:00:00Z'}), /asOf/);
  assert.throws(() => analyze(new Array(20001), options), /20000/);
  assert.throws(() => analyze([], {...options, windowDays: 367}), /windowDays/);
});

test('input data is not mutated, and result is stable for the same input/options', () => {
  const input = sufficient(), copy = structuredClone(input);
  const first = analyze(input, options), second = analyze(input, options);
  assert.deepEqual(input, copy);
  assert.deepEqual(first, second);
});

test('listing adapter has no implicit USD, unit price, region or transaction conversion', () => {
  const listing = {
    id: 'listing', type: 'WTS', priceKind: 'supplier_ask', modelKey: 'iphone 18 pro max', storage: '256GB', condition: 'Brand New',
    grade: null, region: 'hk', color: 'burgundy', activation: 'non_active', currency: 'HKD', price: 100, priceUnit: 'unit', qty: 50,
    availability: 'fulfilled', source: {sender: 'source', isForwarded: false, sourceTimestamp: 1791277200},
    extraction: {method: 'deterministic-v1', flags: []},
  };
  const normalized = adapt([listing])[0];
  assert.equal(normalized.kind, 'asking_price');
  assert.equal(normalized.currency, 'HKD');
  assert.equal(normalized.grade, 'not_applicable');
  assert.equal(normalized.activationStatus, 'non_active');
  const result = analyze(adapt([listing]), options);
  assert.equal(result.counts.included, 1);
  for (const field of ['currency', 'priceUnit', 'region', 'activation']) assert.equal(analyze(adapt([{...listing, [field]: null}]), options).counts.included, 0);
  assert.equal(analyze(adapt([{...listing, source: {sender: 'source'}, timestamp: 1791277200}]), options).counts.included, 0);
});

test('adapter preserves buyer budgets and rejects contradictory type/kind', () => {
  const base = {id: 'b', type: 'WTB', priceKind: 'buyer_budget'};
  assert.equal(adapt([base])[0].kind, 'buyer_budget');
  assert.equal(adapt([{...base, type: 'WTS'}])[0].kind, null);
  assert.equal(adapt([null])[0], null);
});

test('as-is namespace/code is preserved and missing or mapped grades are excluded', () => {
  const values = [sample('good', asIs('DNA')), sample('namespace', {...asIs('DNA'), gradingNamespace: null}), sample('code', {...asIs('DNA'), supplierGrade: null}), sample('mapped', {...asIs('DNA'), grade: 'A'})];
  const result = analyze(values, options);
  assert.equal(result.counts.included, 1);
  assert.equal(result.series[0].dimensions.supplierGrade, 'dna');
  assert.equal(result.series[0].dimensions.gradingNamespace, 'verizon');
  assert.equal(result.series[0].dimensions.grade, null);
});

test('listing adapter retains tested/as-is grade dimensions without inventing activation for used stock', () => {
  const listing = {id: 'asis', type: 'WTS', priceKind: 'supplier_ask', model: 'iphone 18 pro max', storage: '256GB', region: 'hk', color: 'burgundy', currency: 'USD', price: 100, priceUnit: 'unit', qty: 50, ...asIs('DNB'), source: {sender: 'supplier', sourceTimestamp: 1791277200, isForwarded: false}, extraction: {method: 'deterministic-v1', flags: []}};
  const result = analyze(adapt([listing]), options);
  assert.equal(result.counts.included, 1);
  assert.equal(result.series[0].dimensions.activationStatus, null);
  assert.ok(result.series[0].warnings.includes('unknown_activationStatus'));
  assert.equal(result.series[0].dimensions.supplierGrade, 'dnb');
});

test('bounded series and sparse input handling prevent unbounded output or lost counts', () => {
  assert.throws(() => analyze(Array.from({length:129}, (_, i) => sample(String(i), {model: `model-${i}`})), options), /128 exact-spec/);
  const result = analyze(new Array(3), options);
  assert.equal(result.counts.excluded, 3);
});

test('extreme finite prices do not produce an infinite percentage claim', () => {
  const values = sufficient().map(v => ({...v, price: v.id.startsWith('p') ? Number.MIN_VALUE : 1e15}));
  const trend = analyze(values, options).series[0].trend;
  assert.equal(trend.status, 'insufficient_data');
  assert.equal(trend.percentChange, null);
  assert.ok(trend.reasons.includes('numeric_range_exceeded'));
});

test('unknown forwarding status remains visible and blocks a directional change claim', () => {
  const values = sufficient(); values[0].source = {id: 'unverified-origin'};
  const result = analyze(values, options), series = result.series[0];
  assert.equal(series.summary.provenanceUnknownSampleCount, 1);
  assert.equal(series.trend.status, 'insufficient_data');
  assert.ok(series.trend.reasons.includes('unverified_forward_provenance'));
  assert.ok(series.evidence.find(e => e.id === 'p1').warnings.includes('forward_status_unknown'));
});

test('indicative, ambiguous, unsupported and future unknown extraction flags are excluded', () => {
  const flags = ['indicative_price', 'ambiguous_activation', 'ambiguous_battery_health', 'ambiguous_price_or_currency', 'ambiguous_quantity', 'multiple_models_on_line', 'unsupported_grade', 'future_unreviewed_flag'];
  const values = flags.map((flag, i) => sample(String(i), {extractionFlags: [flag]}));
  const result = analyze(values, options);
  assert.equal(result.counts.included, 0);
  assert.equal(result.counts.excluded, flags.length);
  assert.ok(result.exclusions.every(e => e.reasons.some(r => r.startsWith('extraction:'))));
});

test('known optional-context flags stay visible and missing extraction metadata fails closed', () => {
  const result = analyze([sample('a', {extractionFlags: ['location_unknown']})], options);
  assert.ok(result.series[0].warnings.includes('extraction:location_unknown'));
  const listing = {id: 'l', type: 'WTS', priceKind: 'supplier_ask', model: 'iphone 18 pro max', storage: '256GB', condition: 'Brand New', region: 'hk', color: 'burgundy', activation: 'active', price: 100, currency: 'USD', priceUnit: 'unit', qty: 50, source: {sender: 'supplier', sourceTimestamp: 1791277200, isForwarded: false}};
  assert.ok(analyze(adapt([listing]), options).exclusions[0].reasons.includes('extraction:extraction_metadata_missing'));
  listing.extraction = {method: 'deterministic-v1', flags: ['indicative_price']};
  assert.ok(analyze(adapt([listing]), options).exclusions[0].reasons.includes('extraction:indicative_price'));
});
