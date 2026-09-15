# Daily Performance Correction — blocker remediation

Date: 2026-09-16 (Asia/Shanghai). Candidate-only; no deployment or production data mutation.

## Lineage and recovery

- Production/user-approved baseline: `f18e903f721567d4d35c0d19d0a99cd268edf045`.
- Previous candidate: `52d6d8b68271061a582a20c022dbbf7699e75ac4`.
- Branch: `codex/daily-performance-correction`, remote `https://github.com/GPTJJ/budu.git`.
- This remediation commit contains this checkpoint. Resolve exact SHA with `git log -1 --format=%H -- docs/checkpoints/2026-09-16-daily-performance-correction-remediation.md`; match the delivered SHA and remote HEAD before review.
- Authoritative remains `520760eeb8f4bdb8dd71a0853f59c070d70b659d`. No merge/rebase or divergence remediation. Production-only 92/mainline-only 1 refers to the original baseline, not this new candidate.
- Prior checkpoint's current-config correction restriction is superseded below. Historical evidence remains recorded, but prior READY is not an independent Reviewer approval.

## Blocker 1 — one historical source resolver

VERIFIED: existing `resolveDailySalesAuthority` exported by `server/report-center-query.js` is imported directly by `server/daily-entry-upgrade.js`. No logic copy, schema or second authority.

- Reporting, ledger and correction use the same confirmed entry plus the same `daily_confirmation / atomic_confirm` audit evidence.
- Historical confirmed manual stays manual after current config becomes POS.
- Historical confirmed POS remains ineligible for manual correction after config becomes manual.
- Conflicting evidence rejects with HTTP 409 + `code=SOURCE_AUTHORITY_CONFLICT` before mutation.
- Existing broad revision path also resolves historical source, so omitting `scope=sales` cannot bypass POS manual-sales rejection.
- Ledger exposes the resolver decision and `correctionEligible`. UI consumes that server projection plus existing role capability. Conflict values are null/displayed as `—`, not fabricated zero.
- Draft editing/source behavior remains unchanged. Payroll formula, orders and inventory are untouched.

## Blocker 2 — fresh PostgreSQL integration

VERIFIED: new disposable PostgreSQL 16 container `budu-correction-remediation-test`, purpose label `daily-correction-disposable`, dedicated newly allocated anonymous data volume, host loopback port 15487. It was not attached to a production DB volume/network or supplied production credentials. Tests used only synthetic fixtures. Local Docker/PostgreSQL binaries were unavailable, so a separate disposable container was used on the existing host, accessed through a dedicated loopback SSH tunnel; the production PostgreSQL service was not used.

Before migrations/fixture writes the test checks loopback host/port, exact test database name, queries `current_database()` and verifies an empty public schema. It printed:

```text
TEST_DB_ISOLATION = PASS {"database":"budu_correction_test","username":"budu"}
```

Unmodified baseline migrations are applied to that empty public schema, not to `budu_bj006`. The random-schema legacy initializer remains unsuitable for migrations with explicit public references; this is not hidden or fixed by editing migration history.

Fresh API/PostgreSQL suite results:

| Check | Result |
|---|---|
| A: manual history/manual config | PASS |
| B: manual history/POS config | PASS |
| C: POS history/POS config | DENY as required |
| D: POS history/manual config | DENY as required, including legacy revision payload |
| E: conflicting historical metadata | 409 SOURCE_AUTHORITY_CONFLICT; no entry/audit mutation |
| F: report scope = ledger/correction source | PASS |
| Different developer/admin competing at same version | one 200, one 409 |
| Retry identical request | no extra effective write/audit |
| Continuous correction 100→120→110 | exact before/after chain, distinct actor IDs, current 110 |
| Forced audit failure | entry and full audit set unchanged |
| Privileged/staff permissions | PASS |
| Report reads corrected revenue | PASS |
| Existing commission recomputes; payableHours unchanged | PASS |
| Attendance, Employee, Schedule, PayrollNotice preservation | PASS |
| Existing DailyEntry B–F regression | PASS |

Terminal result: `DAILY ENTRY V2 GATE B-F + SALES CORRECTION API TEST OK`. Expected injected 500 responses are checked rollback cases, not ignored suite errors. Final run exited successfully.

Isolated ledger: 73 migrations applied. Final local PG log SHA256: `47b7bea63904bf0a20d3d1b77e83fc76d95f175a9f0275c01d8e7ea583095d7a`. Dedicated test container/anonymous volume, tunnel and preview server were removed/stopped after acceptance; synthetic data is disposable, not business history.

## UI/build regression

- WebKit full StoreEntryPage harness: eligible manual entry reachable, POS/conflict entries absent; conflict does not display ¥0.00.
- 320/340/375/390/430/1280 widths: no horizontal overflow; correction detail displays historical values. Local visual artifact: `output/playwright/remediation-historical-manual-390.png` (not committed).
- Existing daily-entry payroll/orphan dependency/report-source tests: 9/9 PASS, rerun after remediation.
- Build PASS; diff check PASS. Schema/migration diff NONE.
- This is remediation evidence, not a substitute for the requested independent re-review.

## Repeat safely

Use a fresh dedicated disposable PostgreSQL target bound to loopback 15487 with empty database `budu_correction_test`. Set `TEST_DATABASE_URL` using test-only credentials, then:

```sh
DAILY_CORRECTION_ISOLATED=1 node scripts/test-daily-entry-v2-gate-b-api.mjs
node --test scripts/test-daily-entry-v2-payroll-regression.mjs scripts/test-payroll-orphan-dependency.mjs scripts/test-report-center-rc3-source.mjs
npm run build
```

Never use a production tunnel or credentials. The suite writes fixtures and installs failure triggers, so it must not run on an existing business database. Dispose of only the dedicated test target afterward.

## Handoff and boundary

User authorized commit/push on this branch only. Uncommitted/unpushed work is not remotely recoverable; completion requires local/remote SHA equality. Temporary browser outputs and build artifacts remain excluded. Unknown original-worktree changes are preserved. No production deployment, data mutation, migration, runtime verification claim, or authoritative movement occurs. Stop for independent re-review.
