# Report Center V1 RC-6A Candidate

Evidence status: VERIFIED unless explicitly marked otherwise.

## Authority and scope

- Base SHA: `4336372fbbdf6081e98eba89bd42c59ae7efde2a`.
- Candidate branch: `codex/report-center-rc6a-candidate`; the candidate SHA is the published branch HEAD.
- Production/authoritative remained `4a25cd49d373c442543af5063928daf73715bb55` at the gate baseline.
- Production remained database `budu_bj006`, migration ledger 58, failed migrations 0 and one writer at the gate baseline.
- Production was not written, migrated, deployed or merged. Candidate migrations 59–62 exist only on the candidate.

## Canonical cost authorities

- Migration 61 adds append-only `InventoryItemCostHistory`, an effective-date exclusion constraint and a database
  guard for direct `InventoryItem.costPriceCents` changes. Existing current costs become a Shanghai-business-date
  baseline only; no value is backdated and no historical order is recalculated.
- POS and manual external checkout resolve one bounded effective-cost query before snapshotting. Historical COGS
  remains exclusively `OrderItem.costPriceSnapshot × quantity`, including gifts. Refunds are not joined to COGS,
  do not restore inventory and do not reverse cost.
- Migration 62 adds effective-dated store rent, monthly utility estimate/actual facts and confirmed monthly labor
  add-on periods. A confirmed labor period with no entries is the explicit-zero fact; a missing period is not zero.
- Rent supports FIXED, PERCENT, FIXED_PLUS_PERCENT and MAX_FIXED_PERCENT with a frozen GROSS_SALES or NET_REVENUE
  basis. Configurations start on calendar-month boundaries and may not overlap. Missing gross basis is never replaced
  with net revenue.
- Utility keeps both estimated and actual values. Actual overrides estimated for computation while the estimate remains
  auditable. Partial periods use calendar-day allocation and are marked estimated.
- Wage money is read from `loadAuthoritativePayrollRange`; no Report Center wage formula exists. Store allocation uses
  stable Employee.id and `DailyStoreStaff.actualHours` contributions, with deterministic integer-cent reconciliation.
  Incomplete Payroll/actualHours authority fails closed as INCOMPLETE_LABOR.
- Expense history is preserved as other operating cost. Free text is not reclassified or deduplicated; possible overlap
  with structured rent/utility/labor facts is returned as warning metadata. Platform fees are never inferred from
  ExternalSettlement.

## Completeness and permissions

- The authority returns EXACT, ESTIMATED or INCOMPLETE, independent codes for COGS, labor, rent, rent basis, utility,
  current/partial period and source coverage, and separate exact/estimated profit fields. Missing cost is never numeric
  zero. A Manual DailyEntry-only store is INCOMPLETE_COGS.
- `REPORT_COST_VIEW`, `REPORT_LABOR_VIEW` and `REPORT_COST_MANAGE` are explicit, default-off capabilities. Sales access
  does not imply cost access, and store scope remains enforced on the server.
- The Report Center operating-cost panel and Product Center cost-history editor expose only the canonical commands.
  Old Expense UI remains available with an explicit warning that DailyEntry revenue minus Expense is not the new profit
  authority.

## Verification evidence

- Isolated PostgreSQL 16 migration rehearsal 1→58→59→60→61→62: PASS. Migration 61 baseline, no-overlap guard,
  historical OrderItem digest, Migration 62 explicit-zero fact and historical reconciliation all passed.
- Integrated authority fixtures: exact historical month, estimated utility, missing utility, gift COGS, fixed rent,
  Payroll allocation and incomplete profit semantics PASS.
- Rent modes, missing gross basis, partial-month proration and deterministic BigInt allocation unit tests PASS.
- RC-2B Payment/manual-external refund workflow, Payment foundation/reconciliation, RC-3 query authority, Daily Entry,
  Payroll orphan/payable-hours/resolver and Transfer box/piece/notification regressions PASS.
- RC-6A WebKit 320/340/375/390/430: 6/6 PASS with no horizontal overflow. Product Center WebKit: 15/15 PASS.
- RC-4/RC-5 targeted regression PASS after preserving the historical-profit disclaimer.
- Prisma validation, `git diff --check` and production build (2,905 modules): PASS.

## Stop boundary

RC-6A is ready for independent review. Stop here: do not deploy Production, apply migrations 59–62, merge the
authoritative mainline, enter real Production costs or start RC-6B without explicit authorization.
