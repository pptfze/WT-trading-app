# WA Trading: disconnected live-hardening development build

This source package builds on the selected-source privacy work for
https://github.com/pptfze/WT-trading-app at public commit
`a507829abe8f027ffb0998dad0df5269fba92507`. It is a local development milestone,
not a deployed service or a production-readiness assurance. No live WhatsApp,
AI, database, provider, payment, publication or trading account was connected.

## Included workflow

1. An operator-authorized administrator creates a paused channel and explicitly
   selects sources. Groups and individual contacts have separate OFF-by-default
   selections. Individual contacts require an explicit international number;
   no country code, contact alias or LID mapping is guessed.
2. Only authenticated provider events for currently selected sources pass the
   privacy gate. Content is not read before that gate. Provider message ID and
   a usable source timestamp are required. Self-authored messages are excluded.
3. A bounded deterministic text parser extracts separate supported handset
   items from multiline WTS/WTB messages. Unknown facts remain null; no price,
   currency, quantity, grade, condition or regional compatibility is invented.
4. Message identity and all extracted lines commit together in a MongoDB
   transaction. Retried deliveries preserve the original record. Match-building
   failures can be repaired by retrying that delivery without duplicate items.
5. Fresh WTS offers are compared with WTB requests from different source chats
   and different senders. The default freshness window is 48 hours. Known
   specifications and explicit currency must agree. Conflicts are excluded;
   uncertain optional fields are clearly flagged for manual verification.
6. Salespeople share durable matches, claim one using an atomic version check,
   add durable notes and progress the status. Competing claims or stale updates
   return HTTP 409. A claim assigns a salesperson; it does not reserve stock.
7. Historical price observations remain separate by exact specification,
   condition/grade namespace, region, activation, currency and ask/budget type.
   Deterministic analysis works with external AI disabled. Optional AI only
   explains supplied statistics after explicit operational enablement.

## Privacy and source selection

- New channels are paused; every group and individual contact starts OFF.
- Unselected personal chats, unselected groups, broadcast/status/newsletter IDs,
  malformed IDs, unverified aliases and self messages fail closed.
- Individual contact selection uses exact canonical identity and requires a
  matching sender plus explicit `from_me:false`. Selecting a number does not
  select its groups or any other personal chat.
- MongoDB stores policy and deletion tombstones in `channel_privacy`. Fresh
  primary linearizable reads and revision-checked majority writes are used.
- Revocation invalidates outstanding ingestion even across OFF/ON cycles.
  Previously committed records are retained; revoked sources are excluded from
  current listing, match, report and AI data reads. Already transmitted calls or
  committed records cannot be recalled retroactively.
- All source-management routes require a trusted administrator resolved from
  the current account store. Browser storage is never an authorization source.
- Provider credentials remain environment-only. Provider metadata requests do
  not fetch chat histories. The app never automatically sends WhatsApp messages.
- Provider access itself may be account-wide. This application's allowlist does
  not restrict what a linked-device provider can access outside this app.

## Exact trading labels

The parser supports a bounded set of iPhone, Galaxy and Pixel text labels and
common multiline headers/numeric continuation lines. Text is limited to 50,000
characters and at most 100 extracted item lines per message; original selected
text is retained for review, but unsupported/extra lines do not become listings. It is not a product
catalog, arbitrary-language parser, image/OCR extractor or spreadsheet importer.
`18 pm` is normalized to the user's trade label `iPhone 18 Pro Max`; this does
not assert real-world device availability or specifications.

- Storage normalizes GB/TB; RAM stays separate.
- Brand-new activation `active` and `non_active` stay distinct. Activation does
  not imply a condition when the message does not state one.
- Region aliases include HK, Jap/JP, Ch/CN, USA/US, Euro/EU, UK, Sg/SG and India/IN.
- Tested-used grades A+, A, B+, B and C remain distinct. Testing method is retained
  only when stated, such as DrFone or cosmetic.
- As-is supplier grading retains its own namespace and raw normalized code.
  The currently supported explicit namespace is Verizon, with DNA/DNB/DNC/DND;
  those codes are never mapped to generic tested grades. Other namespaces need
  an explicit parser extension and tests.
- Color, regional variant, activation, SIM, RAM, grade namespace, battery health,
  quantity, location, price-unit basis and source provenance are retained.
- Multiple variants, contradictory attributes, malformed/range/indicative prices
  and negated specifications are flagged rather than silently resolved.

A single explicit currency amount is retained. `$` alone does not imply USD.
Only explicit `each`/`per unit` wording establishes a unit price. An ask-to-budget
spread is shown only when both prices are comparable explicit unit quotes; it is
not profit and excludes taxes, freight, fees and negotiation. Missing prices and
quantities stay unknown. MOQ 50 is an optional analysis filter, not an ingestion
rule and not an instruction to buy.

## Durable data and business limits

Production startup requires MongoDB. There is no in-memory runtime fallback.
The following collections are used:

- `channel_privacy`: selected-source policy and tombstones
- `group_messages_v1`: delivery IDs, selected-source original text and metadata
- `group_listings_v1`: normalized items and source evidence
- `group_matches_v1`: shared matches, ownership, version, notes and status
- `group_snapshots_v1`: selected-source aggregate snapshots

The names retain the privacy baseline's prefix; selected-contact records are
explicitly tagged `sourceType:'contact'`. Legacy `listings` and `snapshots` are
quarantined and are never automatically imported or read. Historical migration
would require separate review and authorization. Aggregate snapshots without
source provenance are hidden; current snapshot reads recheck all contributing
sources.

MongoDB replica-set transactions commit message IDs and line items atomically.
This does not provide an exactly-once external provider delivery system. The
provider must retry a failed webhook; there is no durable background intake
queue, provider reconnect manager or production uptime deployment in this build.
Deduplication covers delivery identity and stable cross-channel match origins.
Content fingerprints/forwarded flags provide uncertainty warnings; they cannot
prove that separate reposts represent independent inventory.

Same-ID edits preserve the first committed payload, so provider edits, deletions
and later sold/price-correction updates are not synchronized automatically.
Manual availability changes and freshness checks are required. Source state may
change between a read and a sales action; claims are not inventory transactions. Closing a match
is workflow tracking only: it does not decrement quantity, allocate stock,
prevent a separate lead using the same stock, or establish a confirmed sale
price. Claimed leads remain reviewable after expiry with stale-source warnings;
revoked sources remain hidden.

Matching considers at most 500 opposite listings for an item. Match views are
bounded to 200 stored records per request. Analysis reads at most 2,000 captured
listings and requires a model filter. These are bounded observation views, not
exhaustive market or inventory coverage. See `PRICE_ANALYTICS.md` for cohort,
provenance, exclusion, sample-size and historical-change rules.

## Offline verification

Requires Node.js 24.x (verified locally on 24.19.0). No dependency installation is needed for the tests:

    npm test
    npm run check

Tests use synthetic text, mocked MongoDB/session/provider/AI behavior, route
registration and a VM-based UI harness. They do not connect external services,
start the production listener, use real credentials or inspect private chats.
Mocked transactions verify application behavior, not real replica-set guarantees.
See `TEST_REPORT.md` and `evidence/` for the final counts and verification limits.

## Before an operator runs or deploys anything

1. Review the existing Express, CORS and MongoDB dependencies in an authorized
   environment. MongoDB driver major 6, minimum 6.20, is required for the login
   transaction timeout API; older installed drivers are rejected at startup. No
   package installation, lockfile generation or dependency security audit was done.
2. Set a private strong `JWT_SECRET`, exact `ADMIN_EMAILS` and approved account
   addresses, private `MONGO_URI`, and an explicit `MONGODB_DB_NAME` for a clean
   staging database. The app reads environment variables; it
   does not load `.env` automatically. Never commit credentials.
3. Review `LIVE_HARDENING.md` before any account changes. Public registration is
   disabled; the operator-only utility has not been run against a real database.
   Versioned salted scrypt, transactional login limits and account-revocable
   sessions are implemented. Legacy passwords/tokens are intentionally rejected;
   an authorized operator reset is required, with the owner entering the password.
4. Keep `WHATSAPP_ENABLED=false`, all per-feature AI flags and sharing approvals
   false, and provider/AI credentials empty while reviewing. `AI_ENABLED` is
   ignored. Connecting accounts, transmitting
   selected content to providers/AI and deploying require separate approval.
5. Verify real MongoDB transaction, unique-index, primary linearizable-read and
   majority-write behavior, rollback, failover and concurrency in a replica set.
6. Verify the provider's actual event schema, authenticated webhook support,
   retry behavior and source identity before any live ingestion.
7. Verify hosting HTTPS, narrow reverse-proxy trust and edge request limits.
   Complete real browser/mobile QA, dependency/security review, operational
   monitoring, backups and recovery before considering live operation.

`LIVE_HARDENING.md` documents the new authentication, operator-account and
external-AI boundaries, compatibility changes and remaining activation gates.

The optional local SheetJS asset is not bundled; Excel download remains
unavailable until an authorized reviewed local asset is supplied. No external
CDN is introduced. Manual WhatsApp contact buttons and AI drafts do not send
messages automatically. Nothing has been pushed or deployed.
