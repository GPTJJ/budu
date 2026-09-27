# Developer Safe Delete — Production Checkpoint

Date: 2026-08-29 (Asia/Shanghai)

## Release authority

- Status: **VERIFIED — LIVE**
- Production code SHA: `b6bacb1f061fa10992ee097817d824a237db462f`
- Release branch: `codex/developer-safe-delete`
- Successful GitHub Actions run: `33250216419` — PASS
- Public health: `ok=true`, `env=prod`, `gitSha=b6bacb1f061f`, `dbOk=true`
- Canonical database: `budu_bj006`
- Migration ledger: `56`
- Additive migration: `20260829200000_developer_safe_delete`

## Delivered behavior

- The independent `developerSensitiveRecordDelete` permission is grantable only to an active `developer`; normalization forces it off for every other role.
- Mailing orders, invoices, store transfers, purchase requests, and partner-supply orders support soft delete only.
- Delete and restore require the current developer's separate second password. Five wrong attempts in a ten-minute window cause a ten-minute database-backed lock.
- Delete requires a structured reason and writes an append-only `SensitiveRecordAudit` event; passwords are never logged or stored in audit payloads.
- Normal lists and mutations exclude or reject deleted records. Notifications, unread counts, partner-supply reporting, and relevant exports/statistics exclude deleted records.
- System Settings contains a developer-only deleted-record center with type/date/deleter/reason filters, record detail, audit detail, and second-password restore.
- Restore clears only the soft-delete markers, preserving the original business record ID, child records, and historical facts.

## Data safety and migration

- Migration is additive only: nullable soft-delete metadata and indexes were added to the five business models; rate-limit state was added to `User`; the append-only audit table was added.
- No historical business row was rewritten or physically deleted.
- A fresh protected production backup and blue/green rollback assets were created before migration/cutover.
- Post-migration reconciliation confirmed canonical database `budu_bj006`, one writer, migration ledger 56, and unchanged historical transfer, purchase, mailing, invoice, product, and partner-supply digests.

## Verification

- Permission/contract tests: PASS 13/13.
- Disposable PostgreSQL workflow: PASS for all five domains, including shipped/done/received/paid records, unauthorized admin rejection, wrong-password handling, five soft deletes, exclusion from normal reads/notifications/reporting, preserved children, blocked mutations, audit, restore, unchanged IDs/facts, and rate-limit lock.
- Invoice mobile safe-delete test: PASS 6/6.
- Exact deployment WebKit suite: PASS 93/93.
- Production build: PASS.
- Unrouted candidate smoke: PASS.
- Public production health after cutover: PASS.
- Authenticated production UI smoke: developer deleted-record center visible; invoice safe-delete entry visible; 375px layout and mobile navigation rendered without overlap. No delete, restore, password submission, or other business write was performed.

## Deployment notes

- Initial run `33250120619` stopped before production mutation because stale rehearsal checks hard-coded the prior migration count. Production stayed on the previous healthy release.
- The obsolete count assumptions were retired without changing business behavior; run `33250216419` then completed migration, candidate validation, cutover, reconciliation, and smoke.

## Rollback

- Application and nginx rollback assets from the blue/green release are retained.
- Rollback must preserve the additive columns and audit table unless a separately authorized, destructive migration plan includes fresh backup, dry-run, reconciliation, and executable rollback.
