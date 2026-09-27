# DAILY ENTRY V2 GATE G CHECKPOINT

- Date: 2026-08-31
- Overall: 100% CANDIDATE READY
- Result: PASS
- Branch: `codex/daily-entry-v2`
- Base SHA: `87e3326dc6ad6c4402759faaa58409d70e484061`
- Gate F SHA: `c57c0b4458e2a7c30a69ce408f678e244a50cb73`
- Gate G candidate: the commit containing this checkpoint
- Migration: NONE; ledger remains 58
- Production changed: NO

## Final user flow

- Manual store: local sales, participant, and explicit actual-hours edits produce zero writes until one atomic confirmation command.
- POS store: server POS sales remain read-only; only stable participant identity and explicit actual hours are confirmed.
- Both paths show one success feedback, reload the confirmed facts, become read-only, and display the saved day in the Daily Fact Ledger.
- Dirty date/store/module transitions use the shared unsaved-change Overlay and never silently discard or auto-save.
- Controlled confirmed revision remains a separate reasoned, versioned, audited command.

## Final information architecture

The page is frozen in this order:

1. 今日经营
2. 今日实际值班
3. 闭店核对
4. 每日事实账本

No Report Center concepts, trends, rankings, comparisons, or copied payroll formulas were introduced.

## UX evidence

- Store Entry browser suite: 31/31 PASS across Manual, POS, Schedule prefill, stale-response isolation, confirmation, ledger, detail, revision, and unsaved guard.
- Mobile card/selector/input checks: 320 / 340 / 375 / 390 / 430 PASS with zero horizontal overflow.
- `actualHours` retains decimal mobile keyboard metadata and remains explicit user input.
- Chromium and WebKit ledger/detail internal scroll and bounds: PASS.
- Desktop 1440 compact structure, selector, filters, confirmation, and ledger: PASS.
- Shared Overlay/PTR contract, nested Overlay, internal scrolling, restored page refresh, and WebKit 320–430: PASS.
- Schedule and permission browser regressions: 30/30 PASS.

## Authority and regression evidence

- DailyEntry / DailyStoreStaff / Schedule / permissions / completeness / audit unit suites: PASS.
- Payroll resolver, readiness, payable-hours, stable participant, shadow parity, integration, and fixed formula suites: PASS.
- Production build: PASS.
- Disposable PostgreSQL 16 combined suite: PASS with all 58 migrations.
- Atomic Daily Entry B–F API, Schedule batch, DailyStoreStaff foundation/identity/cutover, and PayrollNotice identity/concurrency suites: PASS.
- Disposable schemas, container, network, source archive, and runner were removed.
- No schema or migration diff exists against the Production base.

## Production read-only reconciliation

- Public health: `200`, `ok=true`, `env=prod`, `dbOk=true`, `gitSha=87e3326dc6ad`.
- Runtime: `87e3326dc6ad6c4402759faaa58409d70e484061`; container healthy.
- Database: `budu_bj006`; read-only transaction verified.
- Migration ledger / failed: `58 / 0`.
- Active non-idle writer count during snapshot: `0`.
- `DailyEntry`: 120 (`confirmed=119`, `draft=1`), digest equals Gate F.
- `DailyStoreStaff`: 139 (`ACTUAL_HOURS=92`, `LEGACY_PAYROLL_HOURS=47`), digest equals Gate F; stable employee FK orphan count 0.
- Existing incomplete actual-hours authority rows: 6; preserved and exposed as completeness debt, never guessed.
- `PayrollNotice`: 7, digest equals Gate F.
- Production was not written, migrated, restarted, or deployed.

## Deployment readiness

- Deployment is an application-only exact-SHA release; Migration = NONE.
- Required preflight: exact candidate lineage from `87e3326`, Production still at expected SHA, `budu_bj006`, ledger 58/failed 0, one writer, public/internal health, clean Production worktree, fresh protected backup, and rollback assets.
- Cutover plan: build exact candidate in a new container, verify internal health and SHA before nginx switch, then verify public health and read-only data digests.
- Rollback plan: retain the current `87e3326` container and nginx target; on any health, authority, or reconciliation mismatch, restore routing to that exact runtime. No database rollback is expected because there is no migration or candidate DB write.
- Deployment was not executed in this autonomous run.

Final Candidate Acceptance and `budu-handoff` are the only remaining authorized steps.
