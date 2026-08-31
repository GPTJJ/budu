# BUDU DAILY ENTRY V2 PRODUCTION ACCEPTANCE

## Result

- Date: 2026-08-31.
- Production: LIVE.
- Daily Entry V2 overall: 95% — awaiting normal production write acceptance.
- Previous Production SHA: `87e3326dc6ad6c4402759faaa58409d70e484061`.
- Deployed SHA: `1199f9bb1214bf13d9a93f304b9982df79d73a02`.
- Functional candidate: `cf60bc161b97c23e2a86314e958ef6abce46e800`; the deployed handoff HEAD adds documentation only.
- Authoritative mainline: `codex/budu-authoritative-mainline` fast-forwarded to the deployed SHA; ahead/behind `0 / 0`.
- Database: `budu_bj006`.
- Migration ledger / failed: `58 / 0`; Candidate migration NONE.
- Report Center touched: NO.
- Production write acceptance: `PENDING USER NORMAL USE`.

## Exact-SHA and preflight evidence

- `cf60bc1..1199f9b` changes only `docs/BUDU_STATUS.md` and the final handoff checkpoint; no runtime, schema, migration, script, package, Dockerfile, or configuration delta exists.
- The Candidate is a direct descendant of the previous Production and no newer authoritative hotfix was present.
- Fresh build from an exact Git bundle passed. Image revision label and runtime `GIT_SHA` both identify `1199f9bb1214bf13d9a93f304b9982df79d73a02`.
- Disk preflight: 32 GiB available before build and 32 GiB after cutover; no broad Docker cleanup was performed.
- Fresh protected custom-format PostgreSQL backup:
  - root: `/opt/budu/.rollback-assets/daily-entry-v2-1199f9b-20260831T012416Z`
  - file: `budu_bj006-migration58-pre-daily-entry-v2-1199f9b.dump`
  - size: `34,948,111` bytes
  - SHA-256: `e8dc10a911f4b89950fed02a6ddab1de95aee5979a1dbe5834e883c25948e904`
  - `pg_restore --list`: PASS; protected checksum-matching copy: PASS.
- Previous runtime container and image, active/templated nginx configuration, and rollback metadata remain available.

## Regression evidence

- DailyEntry, DailyStoreStaff, Payroll authority, permissions, Schedule authority, audit, completeness, and Overlay contract: 25/25 PASS.
- Store Entry state/UI suite across Manual/POS, Schedule prefill, atomic confirmation, ledger, revision, 320/340/375/390/430, and WebKit: 31/31 PASS.
- WebKit Schedule/permissions/Overlay suite: 30/30 PASS.
- Fresh production build: PASS.
- Disposable PostgreSQL 16, never `budu_bj006`, applied all 58 migrations and passed:
  - atomic Daily Entry confirmation/revision/concurrency/rollback;
  - DailyStoreStaff foundation;
  - stable Employee.id identity;
  - identity constraint cutover;
  - PayrollNotice identity/concurrency.
- The disposable PostgreSQL container and network were removed.

## Pre-cutover and Production read-only acceptance

- An unrouted runtime used a database URL forced to `default_transaction_read_only=on`; Payment workers were disabled only for that temporary read-only runtime.
- Internal health: `ok=true`, `env=prod`, `dbOk=true`, `gitSha=1199f9bb1214`.
- Manual Daily Entry overview, existing DailyEntry, DailyStoreStaff, completeness, Schedule Employee.id prefill, and ledger: PASS.
- POS overview and POS-projected ledger revenue: PASS; the manual DailyEntry amount is not consumed as a second sales authority.
- Ledger staff identity matched persisted DailyStoreStaff row IDs exactly; audit details matched persisted DailyEntryAuditLog rows.
- Payroll resolver remained `EMPLOYEE_ID` and fail-closed with `MISSING_DAILY_ENTRY`; incomplete facts were not guessed.
- After nginx cutover, public health returned HTTP 200 with `ok=true`, `dbOk=true`, and `gitSha=1199f9bb1214`.
- Production 390px WebKit verified Manual/POS source labels, actual attendance, actual-hours display, Daily Fact Ledger, confirmed/draft presentation, completeness, audit detail, no horizontal overflow, Overlay page lock, independent detail scrolling, and restored page state after closing.
- Production console errors/warnings after authenticated navigation: `0 / 0`.

## Canonical reconciliation

The same canonical serializer was run before deployment, in the read-only Candidate, and after cutover. All values below remained byte-identical:

- DailyEntry: 120 total; 119 confirmed; 1 draft; confirmed metadata complete 119/119; SHA-256 `e313f36dc31e5c5dd8a981903f2dbcbe785c92d7496db29222aec3a0017a4f19`.
- DailyStoreStaff: 139 total; 131 stable Employee.id rows; 92 `ACTUAL_HOURS`; 86 complete; 47 `LEGACY_PAYROLL_HOURS`; employee FK orphans 0; SHA-256 `1137a6ade3cc0d7e108807d2f7d40363517c767b19323bd73302a17d0681af92`.
- Existing incomplete actual-hours facts: 6; identity/status SHA-256 `2a3899d4c7d520ceb4840525a6737e45270c9a687e9afbc7ff24ff07e565bd9f`.
- DailyEntryAuditLog: 344; SHA-256 `ed54a372f730014b7254492ce4667cbfdd9dbd8b6fdaf9074c14265ee6fcd92a`.
- PayrollNotice: 7; SHA-256 `1eb3916adda88de6b7805f4455040694177a313941d68e640b9375d79282a4db`.
- Migration ledger / failed: `58 / 0`.

No DailyEntry, DailyStoreStaff, DailyEntryAuditLog, PayrollNotice, migration, schema, Payment, Refund, or Report Center fact was changed by deployment or acceptance.

## Runtime and rollback

- New runtime: `budu-prod-1199f9b-daily-entry-v2`; healthy and routed by all three nginx upstream references.
- Previous runtime: `budu-prod-87e3326-product-group`; stopped and retained.
- Canonical writer count: 1.
- Runtime environment, mounts, and networks were preserved; the only environment-value change was `GIT_SHA`. `WECHAT_PAY_ENABLED` was preserved.
- Rollback is an application/nginx switch back to the retained `87e3326` runtime; database rollback is not expected because no migration or acceptance write occurred.

## Remaining acceptance

The next user-normal Daily Entry must complete the real write acceptance without synthetic values:

1. Manual: local edits → stable Employee.id prefill/selection → explicit actualHours → one final confirmation → one success feedback → ledger row.
2. POS: read-only POS sales → stable actual participants → explicit actualHours → one final confirmation → ledger row.
3. Reconcile DailyEntry, DailyStoreStaff, DailyEntryAuditLog, and payroll completeness after that real business operation.

Do not fill or infer revenue, actual attendance, or actualHours merely to finish this acceptance. Do not resume Report Center without a separate authorized Gate.

## Cross-device recovery

1. Fetch `origin/codex/budu-authoritative-mainline` and verify it resolves to `1199f9bb1214bf13d9a93f304b9982df79d73a02`.
2. Read `AGENTS.md`, `docs/BUDU_STATUS.md`, this checkpoint, and `docs/checkpoints/2026-08-31-daily-entry-v2-autonomous-final-handoff.md`.
3. Revalidate runtime, DB, migration, health, writer, and backup evidence before any new Production operation.
4. Await user-normal Daily Entry for the remaining write acceptance; do not manufacture a test record.
