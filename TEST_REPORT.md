# Disconnected live-hardening verification

This report describes synthetic/offline validation only. No WhatsApp provider,
real AI, real MongoDB, real contact, payment service or user account was contacted.
No package installation, push, deployment or public hosting was performed.

## Verification commands

- `npm test`: Node's built-in test runner for `test/*.test.js`
- `npm run check`: JavaScript and inline browser-script syntax checks

Final hardening result (2026-10-12): **417/417 tests passed**, with no
failures/skips; syntax passed for **35 JavaScript files plus one inline script**
on Node.js **24.19.0**. The prior frozen 364-test source remains unchanged. The final run output is stored in `evidence/synthetic-tests.tap` and
`evidence/syntax-check.txt`. Test totals are recorded there and summarized in the
handoff. Checks should be rerun after any further edit.

## Added hardening coverage (53 tests)

- 20 password/session/configuration/limiter/operator tests: randomized salted
  scrypt, exact reviewed parameters, no SHA-256 fallback, malformed credential
  rejection, input bounds, token tampering/expiry/revocation, explicit database
  name and proxy trust, two-instance atomic rate limits, rollback and quota-burn
  prevention, index/error fail-closed behavior, hashed counter identities,
  operator target/role restrictions and guarded utility invocation
- 9 real-handler synthetic auth tests: normalized allowed login, generic
  negative credentials, disabled/legacy/disallowed users, rate-limit setup,
  forwarded-header spoofing, Retry-After, logout-all, current role/password/
  account state and storage outages
- 5 UI VM logout tests: immediate cleanup, one captured-token request, repeated
  click suppression, bounded timeout, error honesty, stale-result guards and
  demo/no-network behavior
- 19 AI hardening tests: independent feature/sharing gates, legacy flag ignored,
  no model fallback, safe configuration status, numeric aggregate reconstruction,
  no arbitrary source/query strings, canonical selected records, source grants
  from original reads, OFF/ON before/during requests, multi-channel single-snapshot
  checks, harmless metadata refresh and no provider-model retry

## Preserved workflow coverage

- Selected-source default deny, strict routing identities and malformed metadata
- Separate explicit group and individual-contact allowlists, OFF by default
- No content reads for unselected private/group sources, no own-message intake
- Exact selected-contact sender/chat match; no LID/c.us/country-code guesses
- Durable policy restart, OFF/ON revocation, deletion tombstones, Mongo CAS and
  fail-closed read/write failures
- Administrator-only source controls, current allowed-account authentication,
  role downgrade and stale browser behavior
- Multiline item extraction, model/storage normalization, explicit currencies,
  quantity/unit-price uncertainty and original source metadata
- User-specific handset shorthand, ACTIVE/NON-ACTIVE, region aliases, colors,
  tested A+/A/B+/B/C and distinct Verizon as-is DNA/DNB/DNC/DND namespaces
- Ambiguous/range/malformed prices, conflicting and negated specs, multiple
  variants, missing fields, unavailable text and parser bounds
- Same-currency known-spec matching, group/contact source separation, freshness,
  missing identity, unavailable/fulfilled exclusions and uncertainty flags
- Transactional message/line persistence with a mock session, repeated and
  concurrent provider IDs, process restart, rollback and repair after a
  committed message's match-building failure
- Atomic match claim CAS, competing salespeople, stale notes/status updates,
  ownership, admin override, note bounds and terminal workflow behavior
- Explicit absence of stock reservation, automatic allocation or inferred sales
- Selected-contact admin→webhook→matching→report/price integration handlers
- Report, price/AI and aggregate snapshot source rechecks, including revocation
  while a mocked AI request is outstanding
- Historical exact-spec price cohorts, ask/budget separation, strict provenance,
  duplicates/forwarding, sample/source/freshness thresholds, insufficient-data
  reporting and optional MOQ filtering
- VM/static UI behavior, authenticated API wiring, request conflicts/timeouts,
  safe currency/condition display, scoped source controls and responsive markup

The previous selected-group privacy tests remain in the suite. Six original
webhook tests were updated to use the production deterministic extraction and
transactional-store path instead of the old external-AI classifier expectation;
their privacy assertions remain in force.

## Independent review

A separate read-only review reproduced and prompted fixes for price ranges,
partial numeric parsing, activation/condition ambiguity, RAM versus storage,
missing buyer identity, duplicate origins, stale owned history, report privacy,
legacy mixed-currency UI calculations and terminal match controls. The source
selection extension was independently tested before import; its four imported
files were hash-verified against the reviewed handoff. The prior combined review is recorded in the baseline handoff. This hardening
copy received a further independent read-only review of password/session code,
operator controls, login limits, AI data minimization and logout. Demonstrated
issues in source-grant timing, sequential multi-channel checks and partial
rate-limit quota reservations were fixed and regression-tested. The reviewer
independently reproduced the final 417-test and syntax pass. No external audit
or browser/production assurance is implied.

## Not verified or not implemented

- No real MongoDB replica-set/driver transaction, index, failover, latency or load
  test. The adapter tests exercise application decisions and filters only.
- No live provider schema/authentication/retry/edit/delete compatibility test.
- No external AI quality test and no actual historical market-price validation.
- No production listener startup or authenticated full HTTP integration test.
- No dependency installation, package vulnerability audit or full security audit.
- Browser VM/static checks do not prove visual layout, accessibility, actual DOM
  behavior, mobile interaction or cross-browser rendering. The original local
  Chromium launch was blocked by an environment socket restriction. The supported
  cloud browser was also checked, but rejected local file:// previews because it
  accepts HTTP/HTTPS only. No restriction was bypassed. No visual/browser pass
  is claimed for this source package.
- No durable inbound queue, provider reconnection service or uptime deployment.
- No automatic edit/delete synchronization, stock reservation, allocation,
  completed-deal pricing, trade execution or outbound WhatsApp message.

Legacy authentication was replaced in this copy, but production identity and
operational verification remain open: authorized operator provisioning/reset,
MFA/recovery decisions, actual MongoDB driver/CSOT and replica-set behavior,
HTTPS/proxy/edge protection, dependency audit/lockfile, backup and recovery,
actual browser/mobile QA and provider/AI activation. The operator utility was
never run against a real database and its hidden TTY prompt remains a manual
staging check. See LIVE_HARDENING.md, README.md and PRICE_ANALYTICS.md.
