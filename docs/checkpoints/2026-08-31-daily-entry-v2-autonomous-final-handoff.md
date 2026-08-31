# BUDU DAILY ENTRY V2 AUTONOMOUS FINAL HANDOFF

## Recovery facts

- Current Gate: Final Candidate Acceptance — PASS; implementation is 100% CANDIDATE READY.
- Remote: `https://github.com/GPTJJ/budu.git`
- Branch: `codex/daily-entry-v2`
- Final implementation Candidate SHA: `cf60bc161b97c23e2a86314e958ef6abce46e800`
- Handoff archive: the documentation-only commit containing this checkpoint.
- Base / Production SHA: `87e3326dc6ad6c4402759faaa58409d70e484061`
- Gate B SHA: `30f9dcbceff3c992d0fcf13ae9b8892bdde99b40`
- Gate C SHA: `164ba3a1506a0fccff3fb907fafd438687274860`
- Gate D SHA: `84627397ff99e6b3a65dd7f3b44c0326bde9f00e`
- Gate E SHA: `056b156063b39a52fc847ad91c05519c63b9adbf`
- Gate F SHA: `c57c0b4458e2a7c30a69ce408f678e244a50cb73`
- Gate G SHA: `cf60bc161b97c23e2a86314e958ef6abce46e800`
- Migration: ledger 58; Candidate migration NONE; schema diff NONE.
- Report Center / Payment / Refund touched: NO.
- Production deploy/write/restart/migration performed: NO.

## Accepted scope

- Schedule prefill uses stable `employeeId` only; legacy name-only shifts remain unresolved and are never guessed.
- Schedule is draft prefill, not actual attendance or payable-hours authority.
- Manual sales plus actual participants/hours confirm atomically with versioning, advisory locking, authorization, and audit.
- POS sales remain server read-only; actual attendance confirms independently in the same Daily Entry command.
- Daily Fact Ledger reads persisted `DailyEntry`, `DailyStoreStaff`, and real audit facts; current Schedule cannot rewrite history.
- Confirmed history is ordinarily read-only and can change only through the explicit reasoned/versioned controlled revision command.
- `DailyStoreStaff.actualHours` remains the current payroll authority; `LEGACY_PAYROLL_HOURS` remains read-only compatible history.
- Page structure is frozen as 今日经营 / 今日实际值班 / 闭店核对 / 每日事实账本.

## Test evidence

- Store Entry Chromium/WebKit suite: 31/31 PASS, including Manual/POS confirmation, refreshed persistence, ledger, detail, revision, guard, and 320/340/375/390/430 bounds.
- WebKit Schedule/permissions/Overlay suite: 30/30 PASS.
- DailyEntry, DailyStoreStaff, Schedule, permissions, completeness, audit, overlay, and payroll targeted unit/integration suites: PASS.
- Fixed payroll pre/post parity and A+B Schedule versus A+C actual-attendance E2E: PASS.
- Controlled 8 → 6 hours revision changes payroll to 6 while immutable audit retains 8 → 6: PASS.
- Production build: PASS.
- Isolated PostgreSQL 16 with all 58 migrations: PASS.
- Combined DB suites: atomic confirmation/revision, concurrency/rollback, Schedule batch, DailyStoreStaff identity/cutover, PayrollNotice identity/concurrency: PASS.
- Test containers, schemas, networks, source archives, and remote runner: removed.

## Production baseline — read-only VERIFIED 2026-08-31

- Public health: `200`, `ok=true`, `env=prod`, `dbOk=true`, `gitSha=87e3326dc6ad`.
- Runtime: `87e3326dc6ad6c4402759faaa58409d70e484061`; healthy.
- Canonical database: `budu_bj006`.
- Migration / failed: `58 / 0`.
- Canonical-DB-connected runtime count: `1` (`budu-prod-87e3326-product-group`).
- `DailyEntry`: 120 (`confirmed=119`, `draft=1`), digest stable through Gate F/G.
- `DailyStoreStaff`: 139 (`ACTUAL_HOURS=92`, `LEGACY_PAYROLL_HOURS=47`), digest stable; employee FK orphans 0.
- Existing incomplete current-authority rows: 6; preserved and surfaced as completeness debt, never guessed.
- `PayrollNotice`: 7, digest stable.

## Deployment readiness

- Recommendation: GO for a separately authorized Production Deployment Gate.
- Exact source candidate: `cf60bc161b97c23e2a86314e958ef6abce46e800` (documentation-only handoff commit may be omitted from the runtime artifact).
- Preflight must reverify expected Production SHA, Candidate lineage, `budu_bj006`, ledger 58/failed 0, one writer, health, clean Production worktree, fresh protected backup, and rollback assets.
- Start a new exact-SHA container and verify internal SHA/health before switching nginx; then verify public health and read-only digests.
- Retain the current `87e3326` runtime as rollback target. No database rollback is expected because Candidate has no migration and deployment must not write business data.
- This handoff does not authorize deployment.

## Remaining blockers

- No Candidate blocker.
- Production acceptance remains NOT RUN because deployment was explicitly prohibited in this autonomous run.
- Six pre-existing Production `ACTUAL_HOURS` rows lack `employeeId` or `actualHours`; this is explicit historical completeness debt, not a Gate C–G regression. Do not guess or mutate them during deployment.

## Cross-device recovery

On the next device:

1. `git fetch --all --prune`
2. Check out `codex/daily-entry-v2` from `origin/codex/daily-entry-v2`.
3. Verify remote branch contains implementation SHA `cf60bc161b97c23e2a86314e958ef6abce46e800` and this handoff checkpoint.
4. Re-read `AGENTS.md`, `docs/BUDU_STATUS.md`, this checkpoint, and Gate C–G checkpoints.
5. Revalidate current Production Git/runtime/DB/migration/health/writer facts before any deployment decision.

Uncommitted work cannot be recovered on another device through Git, and committed-but-unpushed work is unavailable remotely. At final handoff there is no intended uncommitted or unpushed task work. No unknown local changes were discarded; none existed in this isolated worktree. Production claims above are time-stamped and must be reverified before use.
