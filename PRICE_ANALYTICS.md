# Deterministic trade-price observations

Small dependency-free CommonJS module for Node.js 18+. No database, network,
external packages, AI credentials, account access, transactions or side effects.
It is a development component, not a deployed feature or a trading recommendation.

## Run

```sh
npm test
npm run check
```

All tests are synthetic and use only built-in Node modules. No installation is
needed. Verification in this workspace: 32 tests pass; syntax checks pass.

## Integration contract

```js
const { analyzePriceTrends, observationsFromListings } = require('./lib/price-trends');
const result = analyzePriceTrends(observationsFromListings(authorizedListings), {
  asOf: '2026-10-12T12:00:00Z', // explicit clock, never inferred
  bucket: 'week',              // UTC Monday–Monday; or UTC calendar 'day'
  windowDays: 56,
  freshForDays: 14,
  minSamples: 3,
  minSources: 2,
  minQuantity: 50,             // business MOQ filter; default null means no MOQ filter
});
```

Only pass records already permitted by the selected-group privacy boundary.
Do not read or migrate quarantined legacy collections. Filter to the requested
model/spec before calling: the limits are 20,000 input rows, 128 exact-spec
series, and 366 days. Oversized input throws rather than truncating silently.
Validate/catch these errors at the API boundary. Output counts and exclusion
reasons must remain visible in the UI, including when no series survives.

### Matching-listing adapter

The adapter is intentionally strict. It consumes the builder's actual fields:

- `id`, `modelKey || model`, `storage`, `condition`, `grade`, `gradingMethod`
- `tradeClass` (`tested` or `as_is`), `supplierGrade`, `gradingNamespace`
- `region`, `color`, `activation` (`active` or `non_active`), `sim`, `ram`
- `batteryHealth`, `location || listingCountry`, `shippingTerms`
- `price`, `currency`, `priceUnit`, `qty`, `type`, `priceKind`
- `extraction.flags` (required, may be an empty array)
- `source.sender`, `source.sourceTimestamp` (original Unix seconds),
  `source.provider`, `source.providerMessageId`, `source.channelId`,
  `source.lineIndex`, `source.isForwarded`, `source.contentFingerprint`
- If explicitly forwarded: `source.originalSourceId`,
  `source.originalTimestamp` (Unix seconds), `source.originalOfferId` if known.

`WTS` plus `supplier_ask` becomes `asking_price`; `WTB` plus `buyer_budget`
becomes `buyer_budget`. A contradictory/missing type or kind is excluded.
`fulfilled`, `closed`, `dismissed`, and other workflow statuses never establish
a completed transaction. There is no inferred transaction amount or price.

New goods with no grade fields receive explicit `not_applicable` grade,
grading method, trade class and supplier-grade dimensions. This reflects the
known new condition, and never fills a missing used grade. New activation and
color remain mandatory. For Used/Refurbished stock, trade class and grading
method are mandatory. Tested stock requires a distinct A+, A, B+, B or C grade;
as-is stock requires its own supplier-grade namespace and code, and must have
no generic tested grade. Verizon DNA/DNB/DNC/DND are separate exact values;
their meanings are not interpreted or mapped. Used activation may be null,
is explicitly flagged, and is never combined with a known activation value.

No default USD, inferred geographic region, per-piece price, received-time
fallback, grade conversion, FX rate, or model alias exists in this module.
Unit price must be explicitly `unit`; lot/total/bundle prices are excluded,
not divided by quantity. Dates and source identities must be preserved by
the trusted parser. A provider receipt timestamp is not an original offer date.

The adapter preserves extraction flags. Indicative prices (such as “around” or
“from”), ambiguities, unsupported grades and every unrecognized flag exclude
the row. Missing extraction metadata also excludes the row. Only the explicit
allowlist of optional-context missing flags (`location_unknown`,
`quantity_unknown`, `sim_unknown`, `ram_unknown`, `battery_health_unknown`,
`shipping_terms_unknown`, `activation_unknown`) remains as visible warnings;
the ordinary critical-field and MOQ checks still apply. A flag indicating
ambiguity can never be dismissed merely because another field has a value.

### Direct observation shape

The pure function also accepts normalized observations without the adapter:

```js
{
  id: 'listing-123',
  model: 'iphone 18 pro max', storage: '256GB', condition: 'Brand New',
  grade: 'not_applicable', gradingMethod: 'not_applicable',
  tradeClass: 'not_applicable', supplierGrade: 'not_applicable',
  gradingNamespace: 'not_applicable',
  regionalVariant: 'HK', color: 'burgundy', activationStatus: 'non_active',
  sim: 'dual physical', ram: null, batteryHealth: null,
  market: 'Hong Kong', shippingTerms: 'ex works',
  currency: 'USD', price: 100, priceUnit: 'unit', quantity: 50,
  kind: 'asking_price', // or buyer_budget, completed_deal
  observedAt: '2026-10-06T09:00:00Z',
  source: {
    id: 'opaque-original-supplier-id', isForwarded: false,
    provider: 'whapi', accountId: 'channel-id',
    providerMessageId: 'provider-message-id', lineIndex: 0,
    contentFingerprint: 'trusted-normalized-original-message-fingerprint'
  }
}
```

Dates must include time and a timezone. Invalid, future and out-of-window dates
are excluded. No date is inferred from receipt time or the current clock.
`completed_deal` additionally requires `verified: true` and `verificationRef`.
Only a future separately reviewed, authorized transaction workflow should set
those fields. The module cannot itself authenticate proof of a sale.

Whitespace/case normalization is cosmetic only. Semantic aliases belong in
the trusted parser: HK and Hong Kong would be different here if supplied
inconsistently. Currency must be an explicit three-letter code; membership
in a current currency registry is not verified by this offline component.

## Exact cohorts and unknown fields

Each cohort includes model, storage, condition, grade, grading method, trade
class, supplier-grade namespace/code, region, color, activation, currency,
price kind and price unit. SIM, RAM, market, shipping terms and exact battery
percentage also distinguish cohorts when supplied. Their nulls are flagged in
warnings and are never combined with known values. They do not independently
block descriptive comparisons; always show those warnings. Unknown critical
specs are excluded. Missing market/terms therefore cannot be presented as a
delivered or destination-specific price benchmark.

The median is observation-weighted, not quantity- or source-weighted. Different
lot quantities at or above the optional MOQ remain in one cohort. Quantity
discounts, warranties, freight, tax and fees are not normalized. Do not describe
this as a fair-price estimate, an executable price, profit, demand, or a sales
volume measure. Sample counts describe captured observations, not the market.

## Deduplication and provenance

- Record IDs, scoped provider/account/message/line IDs, original offer IDs,
  trusted content fingerprints, and exact source/spec/price/original-time
  tuples deduplicate before aggregation, including across bucket boundaries.
- Fingerprints are duplicate-content indicators, not proof of independent
  origin. They include exact item dimensions/price in the dedup key so
  different line items in one message survive. Reused identities or identical
  content with inconsistent dates/origins cause all conflicting rows to be
  excluded, not an arbitrary first/last winner. Identical generic messages
  from real separate suppliers may therefore be excluded conservatively.
- An explicitly forwarded offer needs its original source and date, matching
  the observation, plus an original offer ID or trusted fingerprint. Missing
  original provenance excludes the row. Reposts cannot refresh an old date.
- Unknown forwarding status remains visible in per-evidence warnings/counts
  and blocks a directional comparison in affected comparison buckets.
- Source counts measure supplied IDs, not proof of independent people or
  businesses. Sybil identities and modified forwarded text are not detectable
  here. SHA-256 source references reduce accidental contact disclosure in
  output; they are pseudonymous, not anonymization or an authorization layer.

## Results and conservative trend rules

Every cohort returns median, minimum, maximum, sample count, unique-source
count, fresh/stale counts, dated evidence, duplicate IDs and UTC bucket bounds.
Empty buckets remain visible. The current partial bucket and a partially
covered first bucket are labeled incomplete and excluded from comparisons.

Only the latest two adjacent completed buckets are compared. Each needs at
least three observations from at least two source identifiers, and the latest
needs those minimums among fresh observations as of the supplied clock. Those
minimums cannot be lowered. Missing buckets, stale latest samples, insufficient
counts, or unknown forwarding provenance return `insufficient_data` with
reasons and null directional/percentage values. We never skip a gap to produce
a more flattering comparison. The completed buckets can be inspected even
when no trend is justified.

`observed_change` means a change between two captured medians. It is not
statistical significance, an extrapolation, a forecast, a buy/sell signal or a
recommendation. Comparisons may use different suppliers in the two periods.
An optional future language model may paraphrase already-computed numbers,
dates, source counts, exclusions and limitations only; it must not add prices,
invent an explanation or label a forecast. This module performs no AI call.

## Verification limits

Tests cover exact-cohort separation, ACTIVE/NON-ACTIVE, all tested grades,
as-is namespaces/codes, asking/budget/verified-sale distinction, dedup conflicts,
forwarding provenance, missing specs, invalid dates/prices, incomplete windows,
sample/source/freshness thresholds, MOQ, no mutation, extreme-number safety,
bounded output and adapter behavior. These are isolated synthetic unit tests.
No live provider, MongoDB, user data, full server route, UI, network integration,
or real historical price accuracy was tested. This folder has not been pushed,
deployed or connected to any account.
