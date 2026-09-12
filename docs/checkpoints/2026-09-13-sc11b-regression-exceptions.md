# Broader regression exceptions — 2026-09-13

Status: STALE_UNRELATED_TEST_FIXTURE. Not PASS. No unrelated code/test edits.
Independent review verified all eleven failing test files and relevant production
implementations are byte-identical to baseline `95cd9ce` using Git blob identity.

The initial critical runner passed 48 files. Its default PostgreSQL port 5432
was unavailable. Re-running 29 DB failures with the guarded loopback native test
database passed another 20 files. Nine DB files and two UI files remain:

| Test | Direct cause |
|---|---|
| payroll-shadow-calculator | Old assertion expects MISSING_DAILY_ENTRY. Unchanged payrollShadowInput explicitly excludes the missing-entry row and categorizes it as ORPHAN_DAILY_STORE_STAFF. Diagnostic: zero stable rows, empty unresolvedDays, one orphan. |
| mailing-qr-migration-rehearsal | Stale hardcoded migration count. |
| store-transfer-migration-rehearsal | Stale hardcoded migration count. |
| transfer-box-piece-migration-rehearsal | Stale hardcoded migration count. |
| transfer-actual-shipment-migration-rehearsal | Stale hardcoded migration count. |
| product-material-migration-rehearsal | Stale hardcoded migration count. |
| unified-product-center-migration-rehearsal | Stale hardcoded migration count. |
| product-category-migration-rehearsal | Excludes ProductCategory creator but retains 20260904170000 dependent FK migration: relation missing. |
| partner-supply-migration-rehearsal | Excludes PartnerSupplyOrder creator but retains 20260829200000 dependent ALTER: relation missing. |
| store-entry-state-integrity | August fixture versus current-month UI. Temporary diagnostic selecting August passes 2/2. |
| store-entry-performance-staff-display | Generic select matches three controls; obsolete performance-duty-staff selector is absent from unchanged UI; ledger API fixture also absent. |

Count assertions expect 55/57/58 even though baseline already had 70 migrations.
Current full isolated database has 73; historical filtered rehearsals differ.
The new migrations were successfully applied to the native full chain. This is
not a substitute for the later Production clone/historical comparison gate.

Logs are local diagnostics, not Production evidence:
`/tmp/sc11b-critical-regression.log`, `/tmp/sc11b-critical-native-retry.log`.
Do not label the original broad critical command green. Do not rewrite payroll
authority or historical migration behavior to satisfy these unrelated fixtures.

## G9 fixture closure

The original failures above remain historical evidence, not a waived PASS.
Test-only repairs now align eight migration rehearsals with actual ordered
historical prefixes and exact applied migration identities (8/8 native PASS).
Payroll orphan expectation now asserts exclusion and diagnostic identity; no
formula/input authority changed. Browser fixtures explicitly select August and
provide current ledger DTOs/selectors, preserving zero-write and stable-identity
assertions (state32/32, performance16/16 PASS). No Production UI change.
The final critical-run status is recorded separately in the candidate checkpoint.

Final critical runner: PASS79 / FAIL0 (including environment isolation self-check).
