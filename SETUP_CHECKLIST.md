# WT staging setup checklist

Status: local development package only. **417 offline tests pass; nothing is deployed.**

1. Obtain approved access to the intended repository and hosting environment.
   Use Node 24.x. Review/install dependencies, generate a reviewed lockfile and
   run a vulnerability audit; MongoDB driver must be major 6, version 6.20+.
2. Choose an isolated MongoDB replica-set staging database. Privately configure
   `MONGO_URI`, explicit `MONGODB_DB_NAME`, a strong `JWT_SECRET`, `ADMIN_EMAILS`
   and approved `APP_ALLOWED_EMAILS`. Do not paste credentials in chat or commit
   them. The app does not automatically load an `.env` file.
3. Keep WhatsApp and every AI feature/sharing flag OFF. Run the full test/syntax
   checks, then verify real Mongo transactions, indexes, timeouts, rollback,
   multi-instance limits, account revocation, backups and restore.
4. With the owner's approval for the exact account/action, review the private
   operator utility (`npm run operator:help`). The owner enters and confirms any
   new password personally. Public signup is disabled; old SHA-256 passwords and
   old sessions do not work. No account has been provisioned by this package.
5. Verify HTTPS, reverse-proxy trust, edge request limits and real browser/mobile
   sign-in/logout flows. App-only controls do not provide DDoS protection or MFA.
6. Only after provider approval and secure access, test authenticated WhatsApp
   webhooks using synthetic selected/OFF groups and contacts. Real content intake
   must respect each explicit source selection. No automatic sending is enabled.
7. Optional price AI: verify the Anthropic account, supported model and approved
   spending, then configure its key/model privately and enable only the two
   aggregate-price flags after sharing approval. Keep briefing/profile/autoreply/
   item flags OFF. There is no automatic model fallback or live-provider test.
8. Approve the intended live deployment only after these checks and operational
   recovery/monitoring are complete. Keep staging and live databases distinct.

Details and exact flags: `LIVE_HARDENING.md`; verification: `TEST_REPORT.md` and
`evidence/`; functional limits: `README.md` and `PRICE_ANALYTICS.md`.
