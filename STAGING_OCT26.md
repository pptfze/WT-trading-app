# Disconnected staging review — 26 October 2026

This draft replaces the old default-allow application on a **separate staging
branch only**. It must not be merged or deployed merely because offline tests
pass. The old service, its database, and repository main branch are unchanged.

## Reproducible runtime

Node 24.22.1; committed npm lockfile. `npm ci --ignore-scripts` installed 82
packages. Resolved direct dependencies: Express 4.22.3, cors 2.8.6, MongoDB 6.21.0.
No dependency declares an install script. The original Library package's 417
offline synthetic tests passed before this staging change; final regression and
integration results must be read from the exact PR commit's CI, not inferred
from historical `evidence/` files. This is a plain Node application: no separate
frontend build/typecheck/lint command is defined.

CI uses a disposable loopback-only MongoDB 8 replica set and randomly named
`wt_ci_*` databases, never Atlas credentials. It tests actual transactions,
rollback, deduplication, shared login limits, and real HTTP login/logout with
synthetic accounts. It also runs the offline suite, syntax validation and npm
audit. CI uses read-only repository permissions and no application secrets.

## Proposed Render setup (not applied)

`deploy/render.staging.yaml` is a review template, not an applied Blueprint.
It targets a new service, explicit staging branch, Virginia, auto-deploy OFF,
Node 24.22.1, `npm ci --ignore-scripts && npm run check && npm test`, `npm start`,
and `/health`. Its current free-plan placeholder is **not** a choice or purchase
approval; select the approved compute plan before creation. No old service is
transferred or deleted. Blueprint structure was validated against Render's
current public JSON Schema; account-level creation/deployment is not verified.

Configure privately after explicit access approval:
- `MONGO_URI`: a dedicated database user restricted to the new database;
- `MONGODB_DB_NAME=wa_trading_selected_staging`: never `wa_trading`;
- `JWT_SECRET`: strong random server-side signing material, at least 32 bytes;
- `ADMIN_EMAILS`, `APP_ALLOWED_EMAILS`: only the explicitly approved people.

Keep `WHATSAPP_ENABLED=false`, empty provider credentials, and all `AI_*` flags
false. Source selection defaults OFF for groups and individual contacts. Do not
reuse old credentials, import old messages, enable broad Atlas network access,
or enable paid services implicitly. Configure verified proxy CIDRs only after
checking the hosting boundary; never set generic trust-proxy true.

## First operator (separate approval and secure interactive step)

Public registration is disabled and startup never creates an account. The
owner must authorize account creation and personally enter/confirm the password
in a private interactive terminal; passwords must not enter chat, arguments,
environment variables or files. Read `npm run operator:help`. With the private
Mongo configuration and approved email allowlists set, the authorized command is:

```
OPERATOR_ACCOUNT_MAINTENANCE=true node scripts/manage-operator.js create \
  --email APPROVED_EMAIL --database wa_trading_selected_staging \
  --name APPROVED_NAME --role admin --apply
```

No account has been provisioned by this work. A supported secure terminal is
still required; do not add an unauthenticated HTTP bootstrap route as a shortcut.

## Remaining release gates

- Review and pass final commit's CI, including real Mongo integration tests.
- Verify account revocation, backups/restore, actual Render HTTPS/proxy behavior,
  and browser/mobile login/logout on the new isolated service.
- Obtain hosting-plan, narrowly scoped database access and operator-account
  approvals; store secrets through supported private interfaces.
- Verify provider account, payload contract, authenticated webhook and phone
  linking only after explicit approval. Source enablement remains individually
  selected; no automated outbound messaging is implemented or authorized.
- XLSX vendor library is absent and export remains unavailable. No claim is
  made that this staging draft is production-ready or a complete migration.

References checked: https://render.com/docs/blueprint-spec,
https://render.com/docs/configure-environment-variables,
https://render.com/docs/compute-plans.
