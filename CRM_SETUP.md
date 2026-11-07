# Buyer CRM build and import handoff

This adds a Buyers CRM to the existing WA Trading app. It is a tested development build, not a claim that the new CRM is deployed or that a live import has occurred.

## What is included

- Searchable company/contact records with linked source evidence.
- Pipeline: New, Contacted, Qualified, Quoted, Won and Lost.
- Assigned salesperson, dated follow-ups, internal notes and versioned updates.
- Offer drafts with explicit currency/price/quantity and owner-only internal approval.
- Owner-only JSON import with preview, source checksum, repeat-import protection and a durable audit record.
- Owner-only export. Suppressed, held and excluded contacts are omitted.
- A salesperson can view only explicitly assigned buyer records and cannot import or export the buyer database.
- New imports are owner-only and have unknown marketing permission. Nothing sends messages or campaigns.

## Prepared November 7 workbook

The separately supplied private import file is prepared from workbook version 38:

- 875 eligible company records.
- 1,206 eligible linked contact rows and 885 eligible linked research rows.
- One compliance hold remains metadata-only. Its one contact row and one research row are omitted.
- USMP and RecirQ / ARA Global Group remain excluded.
- No duplicate stable company IDs or orphan joins were found. One shared phone between LAT-287 and LAT-288 needs manual review; it is not automatically merged.
- Stable source IDs and the original company/contact/research fields are retained. A repeated exact import is idempotent. Changed rows on later import are skipped for review rather than overwriting sales history.

This is a company CRM, not 875 individually verified people. Published numbers, roles and contacts retain the source's uncertainty. No marketing consent is inferred.

## Upload once the new CRM and owner login are ready

1. Sign in using the owner account.
2. Open **Buyers CRM**, then **Import prepared buyer contacts**.
3. Choose the separately supplied `prospects-v38.json`. Do not upload the Excel file directly to this JSON form.
4. Select **Preview import**. For an empty CRM expect 875 inserts, 1 held, 2 excluded, and 1 possible shared-contact duplicate.
5. Review and select **Confirm import**. It should report 875 inserted and 0 skipped.
6. Verify several company records and their source details before assigning a salesperson.

If the response is interrupted, refresh and preview the same file again. The exact-import audit and stable IDs prevent duplicate insertion. A changed or expired preview must be generated again. Holds take precedence over eligible copies, persist on later imports and revoke an existing assignment.

The JSON package contains the private contact database. Keep it separate from source code and do not commit it to the public GitHub repository or place it in `public/`.

## Access and launch gates

The existing hosting service remains separate from this local build. An owner email allowlist is not an owner account. The first owner login still needs secure account provisioning using the existing operator workflow; no password, token or staff login is included here.

Before publication/deployment, confirm the exact code destination and deployment authorization. Preserve the existing app, database and disabled WhatsApp/AI settings. Use a separate source branch/review rather than overwriting historical files.

After the owner account works, the owner must approve the salesperson's exact email and access scope. Provision that individual account securely, then assign only the buyers they should see. Do not share the owner's login. Assignment reveals that buyer's contact methods, notes and sources to the selected person; a user who can see information can still copy or photograph it.

The app does not create staff accounts in the browser, connect WhatsApp, send marketing, send offers, reserve stock or charge money. Internal offer approval is not a send authorization. Verify contact currency, buying authority, stock, terms and required marketing permissions separately.

## Developer verification

Runtime: Node.js 24.x, existing Express/MongoDB dependencies. No new runtime dependency was added. Production startup still requires an authorized MongoDB replica set; there is no in-memory production fallback.

Run:

    npm ci --ignore-scripts
    npm run check
    npm test
    python3 test/prepare-crm-import.test.py

The existing integration workflow additionally runs:

    npm run test:integration

Use only the documented disposable loopback MongoDB replica set for integration tests. Never point the tests at the real customer database. Tests create and drop synthetic databases.

A workbook can be re-prepared with the standard-library converter:

    python3 scripts/prepare-crm-import.py --help

Keep all converter outputs outside the source checkout. The prepared version-38 data was validated against the CRM import implementation with a local synthetic database adapter. This is not a live MongoDB import.

## Known limits

- Real MongoDB transaction/concurrency integration and visual browser QA must pass before launch; they were not completed in this local execution environment.
- Workspace capacity is 10,000 buyers; one import supports up to 2,000 rows and 16 MiB JSON.
- Shared contact/website candidates are flagged, not automatically merged. Copies imported under a different source-file identity require review.
- Follow-up dates are stored and shown but do not trigger automatic reminders.
- Source changes are not automatically synchronized into existing records. Existing buyer history is preserved for review.
- The current free hosting service may sleep while idle; this build adds no paid hosting or provider plan.
