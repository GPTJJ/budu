# Personnel / Payroll disappearing data root fix

Date: 2026-09-13. Scope: read-state/cache only. No migration, payroll formula, identity, actualHours or financial transaction changes.

## Current authority (VERIFIED before deployment)

- Live runtime/container: `budu-prod-a91cb6d-sc11b-online`, SHA `a91cb6d7db7074f77af7e91090f99f58ebdabebf`.
- Public/internal health 200, PostgreSQL `budu_bj006`, 73 applied / 0 failed migrations; exactly one running API writer connected to this DB.
- Branch `codex/personnel-payroll-root-fix` starts at that exact live SHA, preserving intervening Sweet Card 1.1A/controlled 1.1B, Payment/Refund/Partner changes.
- Direct read-only DB: Employee 13 ACTIVE (4 fulltime, 9 parttime), DailyEntry 168, DailyStoreStaff 191, DailyPayAdjustment 9, BigOrderBonus 1, PayrollNotice 20. No DB data loss.
- August entries/attendance: 124/141. September: 44/50.
- Stable sample `emp-53f97563-478f-423c-b269-87bdcaa39f1b` (`BUDU-0004`): August 24 attendance rows, September 9, 2026-08-31–09-06 6. API row identities match DB; production UI September/cross-month detail counts 9/6.
- Directory API returns 13, attendance APIs 141/50, DailyEntry API 168. Notice/adjustment list counts are scoped and are not table counts.

## Root cause and race timeline (VERIFIED)

`src/utils/inventoryAlerts.js` invokes `loadUserData` every 8000ms. In `src/utils/userData.js::loadUserData`, legacy `/userdata` and ten PG reads run concurrently. Previously:

1. Legacy returns; cached is replaced by its normalized snapshot.
2. `cached.entries = {}`, `cached.staff = []`, `cached.stores = []`; month attendance payloads also reset by legacy normalization.
3. The independent Personnel sync tick renders/reads this transient empty snapshot.
4. PG responses repopulate the cache; UI returns to normal.
5. Concurrent same-account base requests lack a latest-request sequence, so late older results can replace newer success.

Production network observation: `/userdata` 200 arrived before PG 200 by tens of milliseconds, repeatedly at eight-second intervals. Deterministic execution of the exact production source reproduces both intermediate staff zero and late-empty overwrite (2 expected failing tests). A normal-network 30-second DOM observation did not capture a zero; it is timing dependent and is not represented as deterministic live reproduction.

Classification: BACKGROUND_REFRESH_CLEAR + FRONTEND_STATE_RACE + STALE_RESPONSE_OVERWRITE. Legacy snapshot and PG competed for the same client cache.

## Previous hotfix semantic audit

Known good `b8c27e817f8d762903957cc0b5c30fe684d9867d` monthly/period/modal guards remain in live source: last-success display, same-context retention, request token checks, errors distinct from empty, stable Employee.id detail. The shared `userData.js` is unchanged between that hotfix and current production; its upstream clearing was outside that earlier fix. Ancestry alone would not identify this remaining failure.

## Fix / invariants

- One synchronous shared-cache commit after response classification. Legacy never seeds or replaces payroll domains. Existing successful PG values/month entries remain until authoritative replacement.
- Account generation + same-account base request sequence rejects superseded responses. Month cache has independent month/request token and account ownership.
- Personnel read metadata: INITIAL_LOADING, DATA, REFRESHING, REAL_EMPTY, ERROR_WITH_STALE_DATA; initial error is ERROR. Counts derive from the retained PG directory, never payroll row state.
- Loading metadata has its own subscriber channel. It is **not** a business-data update: otherwise StoreEntry consumers can refresh their authoritative form too early. Existing business notifications occur after commits.
- Successful empty arrays replace only when current. Failures/aborts/malformed month responses retain payload but mark error; stale payload does not count as a successfully loaded month.
- Monthly display resets only on actual month context change. Period state remains keyed by range and selected month; modal facts derive from current view maps and stable Employee.id. Filter/store/employee are derived views of the scoped immutable source, not competing write caches.
- Payroll calculation/resolver/issuance contracts unchanged. PayrollIssueModal still performs server issue preflight. Retention is visual continuity, never a new financial authority.

## Backend audit / prevention

`server/employee-profile.js` staff-list queries Employee directly with explicit role/store/Employee.id scope; DB unavailable is 503, no cache-miss empty fallback. `server/daily-entry-upgrade.js` attendance uses UTC month start/exclusive next-month end and direct bounded PG query; separate August/September requests cover cross-month ranges. No backend change needed.

Searched Personnel/Payroll for empty-array/count resets. PayrollIssueModal issued/account arrays reset at changed period/initial lookup, not automatic payroll background ticks; these are not employee/payroll display caches. Kept outside this patch. No broad unrelated refactor.

## Regression / soak evidence

- Permanent `scripts/test-personnel-read-race.mjs`: RACE-01..06, base request ordering, successful empty, first-load legacy denial, monthly abort/malformed rejection, read-metadata/commit separation. Included in critical runner.
- Existing payroll browser tests plus `tests/personnel-root-race.spec.mjs`: RACE-06..12, 12 overlap cycles, stable modal identity, cross-month requests vs monthly tick, rapid month/filter switching, initial loading/error/true empty. Chromium + WebKit.
- Initial WebKit five-minute soak: 38 cycles, 3024 samples, zero bad samples/uncaught errors. Final-code dual-browser certification is recorded below when complete.
- Broader critical run required disposable native PostgreSQL at loopback; no production schema used. An initial metadata-notify regression in StoreEntry was fixed; focused StoreEntry suite 32/32 PASS afterwards. No test expectation weakened for that failure.
- DA-4's obsolete static requirement to literally clear cached.entries was replaced with no-clearing assertion plus executable authority tests; PG-only semantics remain enforced.

## Backup and rollback (VERIFIED)

Fresh canonical backup `/opt/budu/.rollback-assets/personnel-root-fix-20260913/baseline-m73.dump` (43,224,342 bytes); SHA256 `f485045e9a819ddbd8b7beeae61a5bf0e7df29494e87c3de599619c2a284eef2`. Archive listing and actual restore into independent, internal-network PostgreSQL PASS. Verification container stopped afterwards.

Original runtime inspect and nginx active/template preserved privately in that directory. Rollback is code/runtime only: stop candidate writer, restart original container, restore saved nginx route/template and reload after `nginx -t`. No DB restore for this frontend defect. Runtime env/mounts must be identical except GIT_SHA; all public rollout flags preserved.

## Production acceptance

Deployment and final production soak are pending at this checkpoint revision. Do not infer production success from candidate tests. Final evidence will record exact SHA, health, writer count, five-minute/30+ cycle DOM+network samples and before/after source/financial digests.
