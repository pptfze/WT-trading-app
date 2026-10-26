'use strict';

const { createHash } = require('node:crypto');
const DAY = 86400000;
const REQUIRED_SPECS = ['model', 'storage', 'condition', 'regionalVariant', 'color'];
const OPTIONAL_SPECS = ['sim', 'ram', 'market', 'shippingTerms'];
const KINDS = ['asking_price', 'buyer_budget', 'completed_deal'];
const NON_BLOCKING_EXTRACTION_FLAGS = new Set(['location_unknown', 'quantity_unknown', 'sim_unknown', 'ram_unknown', 'battery_health_unknown', 'shipping_terms_unknown', 'activation_unknown']);
const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const clean = value => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : null;
const idString = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 512 ? value.trim() : null;
const meaningful = value => value && !['unknown', 'null', 'undefined', '?', 'n/a', 'unspecified'].includes(value);

function instant(value) {
  // No local-time or date-only ambiguity. Epoch values are handled explicitly by the adapter.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return NaN;
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  if (Number(value.slice(11, 13)) > 23) return NaN;
  const calendar = new Date(0); calendar.setUTCFullYear(year, month - 1, day);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return NaN;
  return Date.parse(value);
}

function normalize(raw, index, config) {
  const reasons = [], warnings = [];
  if (!object(raw)) return { error: { index, id: null, reasons: ['invalid_observation'] } };
  const id = idString(raw.id);
  if (!id) reasons.push('missing_observation_id');
  if (raw.extractionFlags !== undefined) {
    if (!Array.isArray(raw.extractionFlags) || raw.extractionFlags.some(flag => typeof flag !== 'string' || flag.length > 160)) reasons.push('invalid_extraction_flags');
    else for (const flag of new Set(raw.extractionFlags)) {
      if (NON_BLOCKING_EXTRACTION_FLAGS.has(flag)) warnings.push(`extraction:${flag}`);
      else reasons.push(`extraction:${flag}`);
    }
  }
  const dimensions = {};
  for (const field of REQUIRED_SPECS) {
    const value = clean(raw[field]);
    if (!meaningful(value) || value.length > 160) reasons.push(`missing_or_invalid_${field}`);
    dimensions[field] = value;
  }
  if (!['brand new', 'used', 'refurbished'].includes(dimensions.condition)) reasons.push('unsupported_condition');
  for (const field of ['grade', 'gradingMethod', 'tradeClass', 'supplierGrade', 'gradingNamespace']) {
    const value = clean(raw[field]);
    dimensions[field] = meaningful(value) && value.length <= 160 ? value : null;
  }
  if (dimensions.condition === 'brand new' && (dimensions.grade !== 'not_applicable' || dimensions.gradingMethod !== 'not_applicable')) reasons.push('new_stock_grade_must_be_not_applicable');
  if (dimensions.condition === 'brand new' && [dimensions.tradeClass, dimensions.supplierGrade, dimensions.gradingNamespace].some(v => v !== 'not_applicable')) reasons.push('new_stock_trade_class_must_be_not_applicable');
  if (['used', 'refurbished'].includes(dimensions.condition)) {
    if (!['tested', 'as_is'].includes(dimensions.tradeClass)) reasons.push('used_stock_requires_trade_class');
    if (!dimensions.gradingMethod || dimensions.gradingMethod === 'not_applicable') reasons.push('used_stock_requires_grading_method');
    if (dimensions.tradeClass === 'tested') {
      if (!['a+', 'a', 'b+', 'b', 'c'].includes(dimensions.grade)) reasons.push('tested_stock_requires_known_tested_grade');
      if (dimensions.supplierGrade !== null || dimensions.gradingNamespace !== null) reasons.push('tested_stock_has_conflicting_supplier_grade');
    }
    if (dimensions.tradeClass === 'as_is') {
      if (!dimensions.supplierGrade || dimensions.supplierGrade === 'not_applicable' || !dimensions.gradingNamespace || dimensions.gradingNamespace === 'not_applicable') reasons.push('as_is_requires_supplier_grade_and_namespace');
      if (dimensions.grade !== null) reasons.push('as_is_must_not_map_to_tested_grade');
    }
  }
  dimensions.activationStatus = clean(raw.activationStatus);
  if (dimensions.condition === 'brand new' && !['active', 'non_active'].includes(dimensions.activationStatus)) reasons.push('new_stock_requires_activation_status');
  else if (dimensions.activationStatus !== null && !['active', 'non_active'].includes(dimensions.activationStatus)) reasons.push('invalid_activation_status');
  else if (dimensions.activationStatus === null) warnings.push('unknown_activationStatus');
  for (const field of OPTIONAL_SPECS) {
    const value = clean(raw[field]);
    dimensions[field] = meaningful(value) && value.length <= 160 ? value : null;
    if (dimensions[field] === null) warnings.push(`unknown_${field}`);
  }
  dimensions.batteryHealth = raw.batteryHealth === null || raw.batteryHealth === undefined ? null : raw.batteryHealth;
  if (dimensions.batteryHealth !== null && (typeof dimensions.batteryHealth !== 'number' || !Number.isFinite(dimensions.batteryHealth) || dimensions.batteryHealth < 0 || dimensions.batteryHealth > 100)) reasons.push('invalid_battery_health');
  if (dimensions.batteryHealth === null) warnings.push('unknown_batteryHealth');
  dimensions.currency = typeof raw.currency === 'string' ? raw.currency.trim().toUpperCase() : null;
  if (!/^[A-Z]{3}$/.test(dimensions.currency || '')) reasons.push('missing_or_invalid_currency');
  dimensions.kind = raw.kind;
  if (!KINDS.includes(raw.kind)) reasons.push('invalid_price_kind');
  dimensions.priceUnit = raw.priceUnit;
  if (raw.priceUnit !== 'unit') reasons.push('explicit_unit_price_required');
  if (typeof raw.price !== 'number' || !Number.isFinite(raw.price) || raw.price <= 0 || raw.price > Number.MAX_SAFE_INTEGER / 4) reasons.push('invalid_price');
  if (raw.quantity !== null && raw.quantity !== undefined && (!Number.isSafeInteger(raw.quantity) || raw.quantity <= 0)) reasons.push('invalid_quantity');
  if (config.minQuantity !== null && (!Number.isSafeInteger(raw.quantity) || raw.quantity < config.minQuantity)) reasons.push('quantity_below_minimum_or_unknown');
  const observedMs = instant(raw.observedAt);
  if (!Number.isFinite(observedMs)) reasons.push('invalid_observed_at');
  else if (observedMs > config.asOfMs) reasons.push('future_observation');
  else if (observedMs < config.windowStartMs) reasons.push('outside_window');
  const source = object(raw.source) ? raw.source : {};
  const sourceId = idString(source.id);
  if (!sourceId) reasons.push('missing_source_id');
  if (source.isForwarded === true) {
    if (!idString(source.originalOfferId) && !idString(source.contentFingerprint)) reasons.push('forward_missing_dedup_identity');
    if (!idString(source.originalSourceId) || !Number.isFinite(instant(source.originalObservedAt))) reasons.push('forward_missing_original_provenance');
    else if (instant(source.originalObservedAt) !== observedMs || source.originalSourceId !== sourceId) reasons.push('forward_provenance_mismatch');
  } else if (source.isForwarded !== false) warnings.push('forward_status_unknown');
  if (raw.kind === 'completed_deal' && (raw.verified !== true || !idString(raw.verificationRef))) reasons.push('completed_deal_requires_verification');
  if (reasons.length) return { error: { index, id, reasons } };
  const key = JSON.stringify(dimensions);
  const tokens = [`row:${id}`];
  if (idString(source.provider) && idString(source.providerMessageId) && idString(source.accountId) && Number.isSafeInteger(source.lineIndex) && source.lineIndex >= 0) {
    tokens.push(`provider:${JSON.stringify([source.provider, source.accountId, source.providerMessageId, source.lineIndex])}`);
  }
  if (idString(source.originalOfferId)) tokens.push(`offer:${JSON.stringify([sourceId, source.originalOfferId, key])}`);
  // A message fingerprint must be supplied by a trusted adapter. Different line items survive.
  if (idString(source.contentFingerprint)) tokens.push(`content:${JSON.stringify([source.contentFingerprint, key, raw.price])}`);
  tokens.push(`exact:${JSON.stringify([sourceId, key, raw.price, observedMs])}`);
  return { value: {
    id, index, dimensions, key, price: raw.price, quantity: raw.quantity ?? null,
    observedMs, sourceId, tokens, warnings,
    verificationRef: raw.kind === 'completed_deal' ? raw.verificationRef : null,
    signature: JSON.stringify([key, raw.price, observedMs, sourceId]),
  } };
}

function deduplicate(values) {
  const parents = values.map((_, i) => i), owners = new Map();
  const root = i => { while (parents[i] !== i) { parents[i] = parents[parents[i]]; i = parents[i]; } return i; };
  for (let i = 0; i < values.length; i++) {
    for (const token of values[i].tokens) {
      if (owners.has(token)) parents[root(i)] = root(owners.get(token));
      else owners.set(token, i);
    }
  }
  const groups = new Map();
  values.forEach((v, i) => { const r = root(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(v); });
  const included = [], conflicts = []; let duplicateCount = 0;
  for (const group of groups.values()) {
    // Reused identities with inconsistent content are not silently resolved by arrival order.
    if (new Set(group.map(v => v.signature)).size !== 1) {
      for (const v of group) conflicts.push({ index: v.index, id: v.id, reasons: ['conflicting_duplicate_identity'] });
      continue;
    }
    group.sort((a, b) => a.id.localeCompare(b.id));
    included.push({ ...group[0], duplicateIds: group.slice(1).map(v => v.id).sort(), warnings: [...new Set(group.flatMap(v => v.warnings))].sort() });
    duplicateCount += group.length - 1;
  }
  return { included, conflicts, duplicateCount };
}

function bucketStart(ms, mode) {
  const d = new Date(ms); d.setUTCHours(0, 0, 0, 0);
  if (mode === 'week') d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  return d.getTime();
}

function stats(values, config) {
  const prices = values.map(v => v.price).sort((a, b) => a - b);
  const n = prices.length;
  const fresh = values.filter(v => config.asOfMs - v.observedMs <= config.freshForDays * DAY);
  return {
    median: n ? (n % 2 ? prices[(n - 1) / 2] : prices[n / 2 - 1] / 2 + prices[n / 2] / 2) : null,
    min: n ? prices[0] : null, max: n ? prices[n - 1] : null,
    sampleCount: n, uniqueSourceCount: new Set(values.map(v => v.sourceId)).size,
    freshSampleCount: fresh.length, staleSampleCount: n - fresh.length,
    freshUniqueSourceCount: new Set(fresh.map(v => v.sourceId)).size,
    provenanceUnknownSampleCount: values.filter(v => v.warnings.includes('forward_status_unknown')).length,
    evidenceIds: values.map(v => v.id).sort(),
  };
}

function compare(buckets, config) {
  const completed = buckets.filter(b => b.complete), previous = completed.at(-2), latest = completed.at(-1);
  const reasons = [];
  if (!previous || !latest) reasons.push('two_complete_adjacent_buckets_required');
  else {
    if (previous.sampleCount < config.minSamples || latest.sampleCount < config.minSamples) reasons.push('insufficient_samples');
    if (previous.uniqueSourceCount < config.minSources || latest.uniqueSourceCount < config.minSources) reasons.push('insufficient_unique_sources');
    if (latest.freshSampleCount < config.minSamples || latest.freshUniqueSourceCount < config.minSources) reasons.push('insufficient_fresh_latest_samples');
    if (previous.provenanceUnknownSampleCount || latest.provenanceUnknownSampleCount) reasons.push('unverified_forward_provenance');
  }
  const result = {
    status: reasons.length ? 'insufficient_data' : 'observed_change', reasons,
    previousBucketStart: previous?.start ?? null, latestBucketStart: latest?.start ?? null,
    delta: null, percentChange: null, direction: null,
    evidenceIds: [...(previous?.evidenceIds || []), ...(latest?.evidenceIds || [])],
    forecast: false,
  };
  if (!reasons.length) {
    const delta = latest.median - previous.median, percentChange = (delta / previous.median) * 100;
    if (!Number.isFinite(percentChange)) { result.status = 'insufficient_data'; result.reasons.push('numeric_range_exceeded'); }
    else { result.delta = delta; result.percentChange = percentChange; result.direction = delta === 0 ? 'unchanged' : delta > 0 ? 'up' : 'down'; }
  }
  return result;
}

function configuration(options) {
  if (!object(options)) throw new TypeError('Options with an explicit asOf timestamp are required.');
  const config = {
    asOfMs: instant(options.asOf), bucket: options.bucket ?? 'week', windowDays: options.windowDays ?? 56,
    freshForDays: options.freshForDays ?? 14, minSamples: options.minSamples ?? 3,
    minSources: options.minSources ?? 2, minQuantity: options.minQuantity ?? null,
  };
  if (!Number.isFinite(config.asOfMs)) throw new TypeError('asOf must be an ISO timestamp with a timezone.');
  if (!['day', 'week'].includes(config.bucket)) throw new TypeError('bucket must be day or week.');
  for (const name of ['windowDays', 'freshForDays']) if (!Number.isInteger(config[name]) || config[name] < 1 || config[name] > 366) throw new RangeError(`${name} must be 1–366.`);
  for (const name of ['minSamples', 'minSources']) if (!Number.isInteger(config[name]) || config[name] < (name === 'minSources' ? 2 : 3) || config[name] > 20000) throw new RangeError(`${name} cannot be below the conservative minimum or above 20000.`);
  if (config.minQuantity !== null && (!Number.isSafeInteger(config.minQuantity) || config.minQuantity < 1)) throw new RangeError('minQuantity must be a positive integer or null.');
  config.windowStartMs = config.asOfMs - config.windowDays * DAY;
  return config;
}

function analyzePriceTrends(observations, options) {
  if (!Array.isArray(observations)) throw new TypeError('observations must be an array.');
  if (observations.length > 20000) throw new RangeError('At most 20000 observations may be analyzed in one call.');
  const config = configuration(options), values = [], exclusions = [];
  for (let index = 0; index < observations.length; index++) { const result = normalize(observations[index], index, config); if (result.error) exclusions.push(result.error); else values.push(result.value); }
  const deduped = deduplicate(values); exclusions.push(...deduped.conflicts);
  const grouped = new Map();
  for (const value of deduped.included) { if (!grouped.has(value.key)) grouped.set(value.key, []); grouped.get(value.key).push(value); }
  if (grouped.size > 128) throw new RangeError('At most 128 exact-spec series per analysis; narrow the requested filters.');
  const step = config.bucket === 'week' ? 7 * DAY : DAY;
  const series = [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, samples]) => {
    const bucketValues = new Map();
    for (const sample of samples) { const start = bucketStart(sample.observedMs, config.bucket); if (!bucketValues.has(start)) bucketValues.set(start, []); bucketValues.get(start).push(sample); }
    const buckets = [];
    for (let start = bucketStart(config.windowStartMs, config.bucket); start <= config.asOfMs; start += step) {
      buckets.push({ start: new Date(start).toISOString(), end: new Date(start + step).toISOString(), complete: start >= config.windowStartMs && start + step <= config.asOfMs, ...stats(bucketValues.get(start) || [], config) });
    }
    return {
      key: hash(key), dimensions: samples[0].dimensions,
      warnings: [...new Set(samples.flatMap(s => s.warnings))].sort(),
      summary: stats(samples, config), buckets, trend: compare(buckets, config),
      evidence: samples.sort((a, b) => a.observedMs - b.observedMs || a.id.localeCompare(b.id)).map(v => ({
        id: v.id, observedAt: new Date(v.observedMs).toISOString(), price: v.price, quantity: v.quantity,
        sourceRef: hash(v.sourceId), freshness: config.asOfMs - v.observedMs <= config.freshForDays * DAY ? 'fresh' : 'stale',
        duplicateIds: v.duplicateIds, verificationRef: v.verificationRef,
        warnings: v.warnings,
      })),
    };
  });
  return {
    schemaVersion: 'price-trends-v1', asOf: new Date(config.asOfMs).toISOString(),
    windowStart: new Date(config.windowStartMs).toISOString(), bucket: config.bucket,
    policy: { windowDays: config.windowDays, freshForDays: config.freshForDays, minSamples: config.minSamples, minSources: config.minSources, minQuantity: config.minQuantity },
    counts: { input: observations.length, included: deduped.included.length, duplicatesRemoved: deduped.duplicateCount, excluded: exclusions.length },
    exclusions: exclusions.sort((a, b) => a.index - b.index), series,
    limitations: [
      'Historical observations only; no forecast, fair-value estimate or buy/sell recommendation.',
      'Asking prices and buyer budgets are not completed transaction prices.',
      'Unique-source counts measure supplied identifiers, not independently verified suppliers.',
      'No currency conversion or adjustment for fees, freight, tax, warranty or quantity discounts.',
    ],
  };
}

function epochISO(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Fail-closed adapter for the matching builder's listings; it never derives deals from fulfilled status. */
function observationsFromListings(listings) {
  if (!Array.isArray(listings)) throw new TypeError('listings must be an array.');
  return listings.map(listing => {
    if (!object(listing)) return null;
    const source = object(listing.source) ? listing.source : {};
    const isNew = clean(listing.condition) === 'brand new';
    const originalAt = epochISO(source.originalTimestamp);
    return {
      id: listing.id, model: listing.modelKey || listing.model, storage: listing.storage,
      condition: listing.condition, grade: isNew && listing.grade == null ? 'not_applicable' : listing.grade,
      gradingMethod: isNew && listing.gradingMethod == null ? 'not_applicable' : listing.gradingMethod,
      tradeClass: isNew && listing.tradeClass == null ? 'not_applicable' : listing.tradeClass,
      supplierGrade: isNew && listing.supplierGrade == null ? 'not_applicable' : listing.supplierGrade,
      gradingNamespace: isNew && listing.gradingNamespace == null ? 'not_applicable' : listing.gradingNamespace,
      regionalVariant: listing.region, sim: listing.sim, ram: listing.ram, color: listing.color,
      activationStatus: listing.activation,
      market: listing.location || listing.listingCountry, shippingTerms: listing.shippingTerms,
      batteryHealth: listing.batteryHealth, currency: listing.currency, price: listing.price,
      priceUnit: listing.priceUnit, quantity: listing.qty,
      extractionFlags: object(listing.extraction) && Array.isArray(listing.extraction.flags) ? listing.extraction.flags : ['extraction_metadata_missing'],
      kind: listing.priceKind === 'supplier_ask' && listing.type === 'WTS' ? 'asking_price' : listing.priceKind === 'buyer_budget' && listing.type === 'WTB' ? 'buyer_budget' : null,
      observedAt: source.isForwarded === true ? originalAt : epochISO(source.sourceTimestamp),
      source: {
        id: source.isForwarded === true ? source.originalSourceId : source.sender,
        provider: source.provider, providerMessageId: source.providerMessageId, accountId: source.channelId,
        lineIndex: source.lineIndex, isForwarded: source.isForwarded,
        originalSourceId: source.originalSourceId, originalObservedAt: originalAt,
        originalOfferId: source.originalOfferId, contentFingerprint: source.contentFingerprint,
      },
    };
  });
}

module.exports = { analyzePriceTrends, observationsFromListings };
