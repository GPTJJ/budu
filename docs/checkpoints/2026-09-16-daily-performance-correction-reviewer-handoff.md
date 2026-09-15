# Daily Performance Correction — Reviewer handoff

Date: 2026-09-16 (Asia/Shanghai). Scope: preserve candidate and independent review only. NO DEPLOYMENT.

## Exact review boundary

- Baseline: `f18e903f721567d4d35c0d19d0a99cd268edf045`.
- Remote: `https://github.com/GPTJJ/budu.git`.
- Candidate branch: `codex/daily-performance-correction`.
- Candidate commit subject: `feat(daily-performance): add audited correction flow`.
- This document is included in that single preservation commit. Resolve its exact SHA using `git log -1 --format=%H -- docs/checkpoints/2026-09-16-daily-performance-correction-reviewer-handoff.md`, then compare with the exact SHA in the delivery report and remote branch. Its parent must be the baseline above.
- Authoritative mainline: `520760eeb8f4bdb8dd71a0853f59c070d70b659d`; unchanged by this task.
- Baseline divergence: Production-only 92, mainline-only 1. Do not include those 92 commits in the feature diff, resolve the divergence, or merge/rebase authoritative mainline.
- Review `git diff f18e903f721567d4d35c0d19d0a99cd268edf045 HEAD` after checking out the exact delivered candidate.
- No production data, runtime, migration, nginx, or deployment action is authorized. Production baseline is the prior verified/user-approved value; this preservation gate does not recertify current production health or ledger.

## Files to review

- `server/daily-entry-upgrade.js`: existing revision transaction gains sales-only intent and idempotency; role gates cover revise and hybrid adjust.
- `shared/accountPermissions.js`: shared privileged correction predicate, retaining existing capability and disabled-user semantics.
- `src/components/DailyPerformanceCorrection.jsx`: reason, original/current/new comparison, second confirmation, retry/stale UI.
- `src/components/StoreEntryPage.jsx`: history detail entry, revised label, audit before/after display, existing refresh path.
- `scripts/test-daily-entry-v2-gate-b-api.mjs`: isolated API/reconciliation tests and guarded public-schema test mode.
- `tests/daily-performance-correction-harness.html`: synthetic browser fixture, never a production data source.
- `docs/BUDU_STATUS.md` and the two scoped checkpoints: recovery and review evidence.

Temporary `.playwright-cli/`, `output/`, `dist/`, dependencies, caches, environment files and credentials are excluded. Synthetic test passwords are fixture values, not production credentials. Unrelated original-worktree files remain untouched.

## Reviewer acceptance checklist

Implementation evidence below is from the completed development gate, not an independent Reviewer PASS. Reviewer must record their own result.

### A. Authority

- Only existing DailyEntry current values and DailyEntryAuditLog history are used; no second correction model/table or endpoint.
- POST `/v2/daily-entry/revise` with `scope=sales` updates income/order count and version atomically with the audit.
- No attendance payload or attendance replacement in the sales-only branch.
- POS/hybrid and conflicting historical source evidence reject manual override. Inspect this boundary, including store configuration changes after confirmation.

### B. Historical integrity

- Audit beforeValue/afterValue retain original and corrected entry values, version, reason, operatorId/operatorName and createdAt (correctedBy/correctedAt equivalents).
- Reason is mandatory; no physical deletion or unlogged overwrite.
- First retained correction before-snapshot supplies original UI data. When a legacy original snapshot is missing, UI says unavailable rather than fabricating it.
- No-op rejects; audit insertion failure must roll back current-value update.

### C. Permissions

- Developer and existing `admin` (Super Admin equivalent) only, with existing REVISE capability and server store access.
- Staff, finance and manager DENY, including the existing hybrid-adjust alternate path.
- Confirmed entries cannot be reopened through unconfirm to bypass correction. Ordinary draft editing remains available under existing permissions.

### D. Concurrency and retry

- Existing store/date advisory transaction lock and expectedVersion guard remain.
- Competing different requests on one version: one success, one 409; no silent overwrite.
- Audit primary key binds actor/requestKey; canonical command digest binds store/date/version/reason/values.
- Same request replay does not write again; changed content under same key rejects.
- UI preserves retry key after network/server failure and blocks stale 409 resubmission pending reopen/refresh.

### E. Real downstream readers

- Ledger and ReportQueryService read latest effective DailyEntry, without parallel summary writes.
- Existing Payroll authority recomputes real revenue-linked commission from corrected facts; actualHours and formulas unchanged.
- Existing payroll notices, bonus/adjustment facts, orders, inventory and transfers are not mutated by this command.
- Shared refresh reloads existing projections. Previously issued/exported documents are not rewritten or resent.

### F. Data and migration

- No changes to Prisma schema or migrations.
- Existing rows are unchanged before an explicit authorized correction; then current DailyEntry changes with an audit in one transaction.
- Isolated tests assert attendance/Employee/Schedule/PayrollNotice preservation, historical preservation, and atomic rollback.
- Production mutation = NO; no real correction is part of this review.

### G. UI

- Existing DailyEntry page → history ledger → store/month/date → detail → 更正数据.
- Verify original/current/new, mandatory reason, second confirmation, 已更正 label, actor/time/reason/before/after audit.
- Verify cancel does not write, save refreshes ledger, and stale conflict is actionable.
- Verify desktop and 320/340/375/390/430 WebKit, no overflow, nested overlay lock until final close.

### H. Regression evidence and reproduction

Development gate passed:

- Full DailyEntry B–F API suite plus correction tests in isolated PostgreSQL: PASS.
- Unmodified migration chain on isolated public schema: PASS.
- Payroll regression, orphan dependency and report source tests: 9/9 PASS.
- Build: PASS.
- WebKit synthetic component + full history-entry checks: PASS, including reason, confirmation, cancel, retry key, stale, widths and overlay stack.

Re-run locally with `npm ci --ignore-scripts`, `npx prisma generate`, then:

```sh
node --test scripts/test-daily-entry-v2-payroll-regression.mjs scripts/test-payroll-orphan-dependency.mjs scripts/test-report-center-rc3-source.mjs
npm run build
```

API suite: supply a fresh disposable PostgreSQL instance exclusively for this test, bound to loopback port 15487, database `budu_correction_test`. Set `TEST_DATABASE_URL` to that local test URL and run:

```sh
DAILY_CORRECTION_ISOLATED=1 node scripts/test-daily-entry-v2-gate-b-api.mjs
```

This opt-in validates host/port/database and runs migrations; never point it at a tunnel to production. It writes synthetic fixtures and intentionally forces audit errors. Expected injected 500 logs are not a suite failure; require final success and zero exit status. Dispose of the test database/container after execution, not any production asset.

Known harness constraint: default random-schema helper fails on pre-existing migrations explicitly referencing public. Do not rewrite those migrations or falsely report that default helper as PASS. The verified path uses an isolated whole database/public schema.

For browser reproduction, start Vite locally and open `/tests/daily-performance-correction-harness.html` using WebKit. `window.__writes` records synthetic requests, `window.__fail=500` tests retry and `409` tests stale rejection. Use `/tests/store-entry-integrity-harness.html` and its existing `__setLedgerPlan` fixture hooks to test the full history entry. Screenshots/tool caches are local evidence only and excluded from Git; regenerate on the review device.

## Cross-device recovery

```sh
git clone --single-branch --branch codex/daily-performance-correction https://github.com/GPTJJ/budu.git budu-daily-performance-review
cd budu-daily-performance-review
git rev-parse HEAD
git log -1 --format='%H %P %s'
git status --short
```

Match HEAD to the delivered Candidate SHA before reviewing. No rebase/merge with authoritative is needed or allowed. Uncommitted work is not remotely recoverable; committed-but-unpushed work is likewise unavailable. The preservation task verifies successful remote publication separately before claiming recoverability.

## Reviewer exit

Report PASS/HOLD with file/line evidence and reproducible blockers. Review readiness is not deployment approval. Stop after review; do not deploy, mutate production, change mainline or solve the 92/1 divergence.
