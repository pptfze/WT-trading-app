'use strict';

// Environment configuration is an operator acknowledgement, not a substitute
// for obtaining the user's approval to share the documented data with Anthropic.
// AI_ENABLED is intentionally ignored: one feature can never enable another.
const FEATURE_GATES = Object.freeze({
  price: Object.freeze(['AI_PRICE_EXPLANATION_ENABLED', 'AI_PRICE_AGGREGATES_TO_ANTHROPIC_APPROVED']),
  briefing: Object.freeze(['AI_BRIEFING_ENABLED', 'AI_BRIEFING_TO_ANTHROPIC_APPROVED']),
  profile: Object.freeze(['AI_PROFILE_ENABLED', 'AI_PROFILE_TO_ANTHROPIC_APPROVED']),
  autoreply: Object.freeze(['AI_AUTOREPLY_ENABLED', 'AI_AUTOREPLY_TO_ANTHROPIC_APPROVED']),
  item: Object.freeze(['AI_ITEM_ENABLED', 'AI_ITEM_TO_ANTHROPIC_APPROVED']),
});
const DISCONNECTED = 'External AI is disconnected for this feature. Deterministic analysis remains available.';
const RETIRED_MODELS = new Set(['claude-sonnet-4-20250514']);
function validModel(value) {
  // No guessed model, alias migration, provider retry or automatic fallback.
  // This checks configuration syntax, not current provider availability.
  return typeof value === 'string' && value.length <= 100 &&
    /^claude-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && !RETIRED_MODELS.has(value);
}
function createAIConfig(env = {}) {
  const model = validModel(env.ANTHROPIC_MODEL) ? env.ANTHROPIC_MODEL : null;
  const key = typeof env.CLAUDE_API_KEY === 'string' && env.CLAUDE_API_KEY.trim() ? env.CLAUDE_API_KEY : null;
  const features = Object.freeze(Object.fromEntries(Object.entries(FEATURE_GATES).map(([feature, [flag, approval]]) => [feature,
    Object.freeze({ enabled: env[flag] === 'true', sharingApproved: env[approval] === 'true' }),
  ])));
  function status(feature) {
    if (!Object.hasOwn(features, feature) || !features[feature].enabled) return 'disabled';
    if (!features[feature].sharingApproved) return 'sharing_not_approved';
    if (!model) return 'model_missing_or_invalid';
    if (!key) return 'credentials_missing';
    return 'ready';
  }
  return Object.freeze({ model, key, features, status, ready: feature => status(feature) === 'ready' });
}

// These are deliberately closed sets. Never pass through arbitrary strings from
// dimensions, warnings, exclusions, evidence, or user-supplied query fields.
const CURRENCIES = new Set(['USD','AED','EUR','GBP','HKD','CNY','JPY','CAD','AUD','SGD','INR','SAR','QAR','KWD','BHD','OMR','ZAR','CHF','KRW','TWD','THB','MYR','IDR','VND','PKR','BDT','EGP','TRY']);
const KINDS = new Set(['asking_price','buyer_budget','completed_deal']);
const STATUSES = new Set(['observed_change','insufficient_data']);
const DIRECTIONS = new Set(['up','down','unchanged']);
const REASONS = new Set(['two_complete_adjacent_buckets_required','insufficient_samples','insufficient_unique_sources','insufficient_fresh_latest_samples','unverified_forward_provenance','numeric_range_exceeded']);
const WARNINGS = new Set(['unknown_activationStatus','unknown_sim','unknown_ram','unknown_market','unknown_shippingTerms','unknown_batteryHealth','forward_status_unknown','extraction:location_unknown','extraction:quantity_unknown','extraction:sim_unknown','extraction:ram_unknown','extraction:battery_health_unknown','extraction:shipping_terms_unknown','extraction:activation_unknown']);
const numeric = (value, min = 0) => typeof value === 'number' && Number.isFinite(value) && value >= min && Math.abs(value) <= Number.MAX_SAFE_INTEGER ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const choice = (value, allowed, fallback = null) => typeof value === 'string' && allowed.has(value) ? value : fallback;
const choices = (values, allowed) => Array.isArray(values) ? [...new Set(values.filter(value => typeof value === 'string' && allowed.has(value)))] : [];
function statistics(value = {}) {
  return {
    median: numeric(value.median), min: numeric(value.min), max: numeric(value.max),
    sampleCount: count(value.sampleCount), uniqueSourceCount: count(value.uniqueSourceCount),
    freshSampleCount: count(value.freshSampleCount), staleSampleCount: count(value.staleSampleCount),
    freshUniqueSourceCount: count(value.freshUniqueSourceCount),
    provenanceUnknownSampleCount: count(value.provenanceUnknownSampleCount),
  };
}
function aggregatePricePayload(analysis) {
  const policy = analysis?.policy || {}, counts = analysis?.counts || {};
  return {
    schema: 'anonymous-price-aggregates-v1',
    bucket: choice(analysis?.bucket, new Set(['day','week'])),
    policy: {
      windowDays: count(policy.windowDays), freshForDays: count(policy.freshForDays),
      minSamples: count(policy.minSamples), minSources: count(policy.minSources), minQuantity: count(policy.minQuantity),
    },
    counts: {input: count(counts.input), included: count(counts.included), excluded: count(counts.excluded), duplicatesRemoved: count(counts.duplicatesRemoved)},
    series: (Array.isArray(analysis?.series) ? analysis.series : []).slice(0, 128).map((series, index) => ({
      label: 'series_' + (index + 1),
      currency: choice(series.dimensions?.currency, CURRENCIES, 'not_disclosed'),
      kind: choice(series.dimensions?.kind, KINDS),
      summary: statistics(series.summary),
      warnings: choices(series.warnings, WARNINGS),
      buckets: (Array.isArray(series.buckets) ? series.buckets : []).slice(0, 368).map((bucket, index) => ({
        period: index + 1, complete: bucket.complete === true, ...statistics(bucket),
      })),
      trend: {
        status: choice(series.trend?.status, STATUSES, 'insufficient_data'),
        reasons: choices(series.trend?.reasons, REASONS),
        delta: numeric(series.trend?.delta, -Number.MAX_SAFE_INTEGER),
        percentChange: numeric(series.trend?.percentChange, -Number.MAX_SAFE_INTEGER),
        direction: choice(series.trend?.direction, DIRECTIONS), forecast: false,
      },
    })),
  };
}
const PRICE_EXPLANATION_SYSTEM = 'Explain only the supplied anonymous historical aggregate statistics. Series labels correspond to the same numbered series in the local report. Every series is a distinct exact specification and currency; never combine series, including currencies marked not_disclosed. No product names, source identities, messages, or user text have been supplied. Do not infer them. Periods are ordered buckets, not individual observations. Report insufficient evidence where indicated. Do not add prices, explanations of cause, forecasts, profit claims, trading recommendations or compatibility claims. Asking prices and buyer budgets are not completed transaction prices. Source counts are not verified supplier counts. No currency conversion or fee, freight, tax, warranty or quantity-discount adjustment has been performed.';

module.exports = { FEATURE_GATES, DISCONNECTED, validModel, createAIConfig, aggregatePricePayload, PRICE_EXPLANATION_SYSTEM };
