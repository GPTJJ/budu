# DAILY ENTRY V2 GATE F CHECKPOINT

- Date: 2026-08-31
- Overall: 88%
- Result: PASS
- Branch: `codex/daily-entry-v2`
- Base SHA: `87e3326dc6ad6c4402759faaa58409d70e484061`
- Gate E SHA: `056b156063b39a52fc847ad91c05519c63b9adbf`
- Gate F candidate: the commit containing this checkpoint
- Migration: NONE; ledger remains 58
- Production changed: NO

## Payroll authority result

- Existing payroll calculation code is unchanged from the Production base.
- `DailyStoreStaff.actualHours` remains the only current actual-attendance pay input.
- Reviewed historical rows continue to use the read-only `LEGACY_PAYROLL_HOURS` arm of the existing tagged union.
- Schedule, `DailyEntry.staffNames`, duty-hour helpers, and unsaved UI state do not enter the payroll resolver.
- Draft days, missing `DailyEntry`, missing `actualHours`, unresolved employee identity, and invalid authority fail closed rather than guessing pay.

## Fixed-fixture reconciliation

- Full-time, part-time, temporary relief, cross-store work, same-name employees, missing hours, draft day, revised attendance, legacy participant, and missing DailyEntry are covered.
- The same persisted facts produce byte-identical stable payroll JSON before and after non-authoritative Daily Entry V2 Schedule/UI metadata is present.
- Existing payroll resolver, readiness, payable-hours, participant-authority, shadow-input, shadow-calculator, integration, and payroll formula suites all pass.

## Isolated PostgreSQL E2E

- All 58 migrations applied to a disposable PostgreSQL 16 schema.
- A saved Schedule contains A+B while confirmed actual attendance contains A+C.
- Authoritative payroll contains A+C only and reads their stable `employeeId` plus `actualHours`; B is absent.
- A controlled revision changes A from 8 to 6 hours; the next payroll load uses 6.
- The immutable `daily_revision` audit preserves the explicit 8 → 6 before/after facts.
- Historical `DailyEntry`, `DailyStoreStaff`, and `PayrollNotice` snapshots outside the test day remain byte-identical.
- The disposable schema, container, network, source archive, and remote runner were removed.

## Production read-only reconciliation

- Runtime: `87e3326dc6ad6c4402759faaa58409d70e484061`; health `healthy`.
- Database: `budu_bj006`; transaction mode `read only`.
- Migration ledger / failed: `58 / 0`.
- Active non-idle writer count during both snapshots: `0`.
- `DailyEntry`: 120 rows (`confirmed=119`, `draft=1`), digest stable across two reads.
- `DailyStoreStaff`: 139 rows (`ACTUAL_HOURS=92`, `LEGACY_PAYROLL_HOURS=47`), digest stable across two reads; employee FK orphan count 0.
- Six existing `ACTUAL_HOURS` rows are incomplete (`employeeId` or `actualHours` absent). They are preserved historical completeness facts and were not modified or guessed.
- `PayrollNotice`: 7 rows, digest stable across two reads.
- Production was not written, migrated, restarted, or deployed.

Next authorized autonomous gate: Gate G — full UX and Production readiness.
