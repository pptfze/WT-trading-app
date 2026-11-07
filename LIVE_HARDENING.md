# Live-hardening development handoff

Date: 2026-10-12. This is a separate local continuation of the frozen 364-test
matching build. It is **not deployed and not yet approved for live operation**.
No account, password, token, provider connection or real database was created,
changed or contacted. Only synthetic credentials and in-memory database fixtures
were used. No package was installed and no provider AI request was made.

## Authentication changes

- Passwords use Node's asynchronous `crypto.scrypt`, with independently random
  16-byte salts, a 64-byte derived key, and the reviewed N=65536, r=8, p=2 profile.
  New passwords require at least 15 Unicode characters and at most 256 UTF-8
  bytes; they are neither trimmed nor truncated. At most two hash operations run
  concurrently per Node process; excess attempts fail closed rather than queue.
- Stored format: `scrypt$v1$65536$8$2$<32 hex salt characters>$<128 hex key characters>`.
  Only this reviewed version/parameter set is accepted. Missing, malformed and
  legacy SHA-256 hashes never authenticate. There is no legacy-enable switch or
  silent login migration. Unknown accounts use a dummy slow derivation when the
  supplied password is structurally valid. Comparisons use `timingSafeEqual`.
- Login accepts only exact operator-allowlisted accounts after canonicalizing
  email casing/outer whitespace. Mongo query objects and oversized input are
  rejected. Public registration remains disabled, including on an empty database.
- Sessions are version-2 HMAC-SHA256 bearer tokens, not standards-format JWTs.
  `JWT_SECRET` retains its historical environment-variable name. It must be set
  privately to strong random signing material of at least 32 bytes. Tokens have
  random IDs, issued-at and expiry checks, and default to eight hours. The
  configurable lifetime is restricted to 900–28800 seconds, with no refresh.
- Every authenticated request re-reads the account on the primary with
  linearizable read concern. The current role is used. Tokens are bound to
  `authVersion` and a fingerprint of the stored password hash. Revocation,
  password replacement, account disabling or removal invalidates existing tokens.
  Role downgrades take effect on the next authenticated request.
- Logout increments the account's `authVersion`, revoking **all** its sessions.
  The UI captures the old token, clears local data immediately, and makes one
  bounded five-second revocation request. It suppresses repeated clicks, ignores
  late results after a new session, and warns if server revocation is unconfirmed.
  Closing a tab only discards the in-memory browser token; it cannot prove server
  revocation. Already authorized in-flight work cannot be recalled by logout.
- API and health responses are marked `Cache-Control: no-store`; MIME sniffing
  and referrer suppression headers are supplied. Tokens remain in browser memory,
  not persistent browser storage. This does not eliminate all XSS risk.

## Shared login attempt limits

`auth_login_limits_v1` contains HMAC-keyed counters and expiry timestamps, never
raw email addresses, IPs or passwords. Each 15-minute fixed window permits at
most 10 attempts per normalized account, 100 per peer IP and 300 total across
instances sharing the same database and signing secret. Unknown accounts and
successful attempts count. Success does not reset counters.

All three reservations commit together in a MongoDB transaction. If any cap is
exceeded, the transaction aborts, including earlier reservations/new records.
Already blocked traffic cannot burn unrelated global quota. Conditional atomic
increments prevent overrun under concurrency. TTL deletion is cleanup only;
window identity, not deletion timing, controls eligibility. Fixed-window limits
allow up to two windows' quota near a boundary. Changing the signing secret or
using different secrets/databases per replica changes the counter namespace.

Missing initialization, timeouts, transaction/index/storage failures and uncertain
results fail closed before password verification. HTTP 429 includes Retry-After.
Counters require the same replica-set/transaction support already needed by the
trade store; standalone MongoDB is insufficient. The login transaction uses a
five-second driver timeout budget, snapshot read concern and majority write
concern. Session cleanup has a separate five-second budget. MongoDB driver major
6, minimum 6.20, is required and checked before startup; the declared dependency
minimum was raised without installing it. Its timeout behavior is documented
but not exercised against a real driver/database in this build.

This is not DDoS protection. An adversary can still lock out a known account or
consume the overall cap across identities/IPs. Verify edge request limits,
resource limits, monitoring and recovery before public exposure. Empty
`TRUST_PROXY_CIDRS` ignores forwarded headers and uses the direct peer. Behind a
proxy this may intentionally combine users under one peer limit. Configure only
the host's verified proxy addresses/ranges; never trust client-supplied forwarding
headers directly. Boolean trust, hop counts, names and `/0` are rejected. Verify
the actual proxy chain and blocked direct-origin access in staging.

## Database and operator-account gate

`MONGODB_DB_NAME` is mandatory and validated. It replaces the hardcoded legacy
database name. A database name in a URI path does not choose the app's database.
Use a clean isolated staging database and least-privileged, privately configured
access. No automatic migration or import of historical records is performed.

The operator-only `scripts/manage-operator.js` supports `create`, `reset-password`,
`disable`, `enable` and `revoke-sessions`. It is never imported by a server route
or run at startup. Review its help without credentials using:

    npm run operator:help

Actual use is a separate authorized security action, not part of this handoff.
The utility requires a private interactive terminal, explicit `--apply`,
`OPERATOR_ACCOUNT_MAINTENANCE=true`, an exact database-name match, an allowlisted
email and typed action/account/database confirmation. Creation requires an
explicit name and role; only ADMIN_EMAILS entries can become administrators.
It cannot overwrite an existing account on create. Other operations never
implicitly create one. Password reset and other changes increment authVersion.
An existing disabled account stays disabled when only its password is reset.

For creation/reset, the owner must personally enter and confirm the new password
at the hidden prompt. Passwords are not accepted in arguments, environment
variables, piped stdin or chat, and are not logged/generated by the utility.
The utility deliberately gives a generic error if an action is not confirmed;
inspect actual account state before retrying an uncertain write. Hidden-terminal
interaction itself still needs human staging verification. There is no public
self-service recovery, email-reset flow or MFA in this build.

## External AI boundary

All features are OFF in `.env.example`. Legacy `AI_ENABLED` is ignored. Every
feature requires its own `*_ENABLED=true` flag, separate Anthropic-sharing
approval flag, a private `CLAUDE_API_KEY`, and an explicitly configured valid
`ANTHROPIC_MODEL`. Values are loaded only at process start. There is no browser
setting/API that can enable sending or alter these approvals.

The aggregate-price-only configuration uses:

- `AI_PRICE_EXPLANATION_ENABLED`
- `AI_PRICE_AGGREGATES_TO_ANTHROPIC_APPROVED`

Setting both true is an operator acknowledgement, **not a mechanism that obtains
the owner's data-sharing approval**. Provider/account access and any costs still
need appropriate authorization before activation. Deterministic price analysis
works with all AI disabled or unconfigured. Responses include a safe `ai.status`
reason: disabled, sharing_not_approved, model_missing_or_invalid,
credentials_missing or ready. Ready means configuration is present; it is not
evidence that the provider/account/model has been verified.

The outbound price payload is freshly constructed from anonymous numeric
statistics: generated series labels, aggregate counts/thresholds, price summary
numbers, numbered time buckets, completion booleans, numeric observed changes
and closed currency/kind/warning/reason enums. Arbitrary strings are never
copied from the source or query. No product/specification text, contact identity,
phone, source/group ID, raw message, user question, evidence record, fingerprint
or timestamp is transmitted. Unknown currencies are marked not_disclosed and
series remain separate. Source counts are not verified supplier counts.

Other AI routes remain independently OFF and require **separate specific**
approval. Their broader scopes are listed below and in `.env.example`:

- Briefing: counts, source-derived product model strings and up to 15 listing
  samples containing type/model/price/currency/seller country.
- Profile: trader query, potentially phone/name, and matching selected-listing
  type, condition, model, grade, price, currency and seller-country strings.
- Autoreply: one selected canonical listing's product/spec/price fields,
  sender identity/country and the user's intent text. It drafts only.
- Item: the user's question text.

Flags: `AI_BRIEFING_ENABLED`/`AI_BRIEFING_TO_ANTHROPIC_APPROVED`,
`AI_PROFILE_ENABLED`/`AI_PROFILE_TO_ANTHROPIC_APPROVED`,
`AI_AUTOREPLY_ENABLED`/`AI_AUTOREPLY_TO_ANTHROPIC_APPROVED`, and
`AI_ITEM_ENABLED`/`AI_ITEM_TO_ANTHROPIC_APPROVED`.

Original source-generation/authorization-version grants travel with the listing
read. The final pre-dispatch check compares all original grants with one fresh
policy snapshot; the response is checked again. Revocation and OFF→ON changes
invalidate an in-flight request, while harmless metadata updates do not. The
database check and external HTTP dispatch cannot be one atomic operation.
Revocation after dispatch can discard the result but cannot retract already
transmitted data. No stronger real-time guarantee is claimed.

There is no default, fallback, model-switch retry or claim that a configured model
is available. Model syntax is validated and the known retired
`claude-sonnet-4-20250514` is rejected. Verify an available supported model and
the account's access/costs at activation. Provider quality and factual reliability
are untested here; explanations must preserve the deterministic report's limits.

## Remaining go-live gates

1. Authorized repository/environment access, reviewed exact dependency lockfile
   and vulnerability assessment. Node runtime target is 24.x; local tests ran on
   24.19.0. No npm install/audit or production listener test was performed.
2. Authorized, isolated real MongoDB replica-set test: driver timeout/retries,
   indexes, shared limits, concurrent transactions, rollback, failover, account
   revocation and durable source policy. Establish backups and restore testing.
3. Owner-approved account provisioning/reset through the private operator flow.
   Legacy passwords and sessions intentionally stop working in this version.
4. HTTPS host, proxy/edge safeguards and browser/mobile/security testing,
   including sign-in, sign-out, reload, late requests and error behavior.
5. Explicit provider approval/access and authenticated webhook validation with
   synthetic selected/OFF groups and contacts before any real message ingestion.
6. Optional aggregate-only Anthropic activation only after approved account,
   secure key handoff, model verification and spending agreement. Keep all other
   AI sharing flags false unless their separate broader data scope is approved.
7. Operational monitoring, error handling, retention/deletion policy and recovery.
   No durable inbound queue, auto provider reconnection or edit/delete message
   synchronization was added in this security scope.

## Primary implementation references

Reviewed 2026-10-12. These support the implementation choices; they are not a
third-party audit or evidence of live integration.

- [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html): scrypt profile choice.
- [Node crypto](https://nodejs.org/api/crypto.html): scrypt, random salts and timing-safe comparison.
- [MongoDB Node driver 6.20 sessions](https://mongodb.github.io/node-mongodb-native/6.20/classes/ClientSession.html#withTransaction): transaction timeout interface.
- [MongoDB client-side timeouts](https://www.mongodb.com/docs/drivers/node/v6.x/connect/connection-options/csot/): precedence, session cleanup and transaction restrictions; CSOT is marked experimental.
- [MongoDB driver 6.20 implementation](https://github.com/mongodb/node-mongodb-native/blob/v6.20.0/src/sessions.ts): transaction/commit behavior reviewed, not executed here.
- [Anthropic model deprecations](https://docs.anthropic.com/en/docs/about-claude/model-deprecations): retired hardcoded model removed; model availability still must be verified at activation.
