# Daily Performance Correction — read-path closure, round 2

Baseline: `f18e903f721567d4d35c0d19d0a99cd268edf045`.
Previous candidate: `51cfe7d9c800e7322458732138875fb2e49bf567`.
Branch: `codex/daily-performance-correction`; remote: `https://github.com/GPTJJ/budu.git`.
Resolve this candidate with `git log -1 --format=%H -- docs/checkpoints/2026-09-16-daily-performance-read-path-closure.md` and verify remote equality before review.

## Read-path audit

| Read path | Previous source logic | Shared historical resolver / action |
|---|---|---|
| Overview | current effective config, even for confirmed entry | now reads confirmation audits and delegates confirmed source to `resolveDailySalesAuthority` |
| Ledger | shared resolver since round 1 | retained; same confirmation evidence |
| Report Center summary/dashboard/profit revenue | `ReportQueryService.resolveScope` | retained; original resolver and math unchanged |
| History/detail | server ledger projection | retained; no client source decision |
| Sales correction | shared resolver under transaction lock | retained; version, role and request guards unchanged |
| Correction entry visibility | server `correctionEligible` + role | retained; overview now exposes the same eligibility |
| StoreEntryPage selected day | overview source; saved correction did not refresh overview | uses corrected overview; conflict hides numeric/edit UI; successful correction refreshes overview without overwriting dirty drafts |
| Legacy POS daily summary | current config filtered orders/refunds | bulk-load confirmed evidence; shared resolver decides inclusion; conflicts return 409 with explicit code |
| Legacy POS product summary | current config filtered items | same bulk evidence adapter; no new source decision or aggregation formula |
| Shared userData/selectors/old dashboard/export | `/daily-entries` raw facts plus POS summary | no client config-based resolver; POS filtering fixed at server source |
| `/daily-entries`, legacy Expense profit | persisted DailyEntry values | raw fact compatibility reads, not manual/POS source selectors; no recalculation or schema changes |
| Payroll authority | persisted DailyEntry + attendance authority | no current source override; untouched formula and issuance facts |
| participants/completeness | attendance identity/hours | does not select a sales source; unchanged |
| confirm / legacy draft edit / store config | new/unconfirmed input configuration | unchanged; confirmed source is not manufactured for an unconfirmed day |

The bulk adapter only fetches/indexes evidence and delegates to the existing resolver. It is not a second authority. Legacy summaries deliberately fail the requested aggregate on conflicting confirmed evidence, rather than choose current config. No new POS financial semantics or aggregation formulas were introduced. Raw persisted snapshot APIs remain fact reads, not a substitute report authority.

## Contract and validation

The isolated API suite now checks overview/ledger/report equality on the same records, before and after correction. Source cases include manual/manual, manual/POS, POS/POS, POS/manual and conflict. Nonzero cash order/item fixtures prove historical source inclusion/exclusion in the legacy summaries; no payment provider is called. Consecutive manual corrections are tested after switching config to POS. New and draft dates remain config-driven.

Test target is a new disposable PostgreSQL 16 container, loopback port 15487, database `budu_correction_test`; new anonymous volume and test-only credentials. `TEST_DB_ISOLATION = PASS` is printed before migrations/fixtures. `budu_bj006` is not targeted. Baseline migrations are unchanged; no new migration.

Commands:

```sh
DAILY_CORRECTION_ISOLATED=1 TEST_DATABASE_URL=<isolated-test-only-url> node scripts/test-daily-entry-v2-gate-b-api.mjs
node --test scripts/test-daily-entry-v2-payroll-regression.mjs scripts/test-payroll-orphan-dependency.mjs scripts/test-report-center-rc3-source.mjs
npm run build
```

Existing permission, idempotency, concurrent version, continuous chain, audit rollback and commission/payable-hours assertions remain in the API suite. The test intentionally raises an audit failure and asserts transaction rollback; an expected 500 is not a skipped failure.

WebKit uses the existing local StoreEntryPage and correction harnesses: historical manual ¥120 with current POS config; conflict without numeric input/correction button; 320/340/375/390/430/768/1280; modal lock/unlock and stale submission rejection. No production browser actions.

## Boundary and handoff

Current run VERIFIED: isolated API suite exited 0 with `DAILY ENTRY V2 GATE B-F + SALES CORRECTION API TEST OK`; unit/source/payroll smoke 9/9; WebKit checks above PASS; build PASS; diff check PASS. Production public health read on 2026-09-16 remained `f18e903f7215`, `env=prod`, `dbOk=true`. Production migration/backup were not re-audited in this candidate-only gate. Local test logs: `/tmp/budu-round2-pg.log`, `/tmp/budu-round2-build.log` (not source artifacts or independent Reviewer evidence).

No deploy, production data write, authoritative mainline move or migration. Mainline stays `520760eeb8f4bdb8dd71a0853f59c070d70b659d`. The known 92/1 divergence is not integrated. Original untracked `.playwright-cli/` and `output/` are preserved and excluded from commits. Uncommitted or committed-but-unpushed changes are not remotely recoverable; delivery requires explicit candidate push and remote equality.

Reviewer should repeat the cross-projection contracts, not rely on this handoff as independent acceptance. Stop after candidate push; deployment remains unauthorized.
