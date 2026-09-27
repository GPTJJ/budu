# Report Center V1 Final Candidate

Evidence status: VERIFIED unless explicitly marked otherwise.

## Authority and scope

- Base SHA: `768a9df8c304d0fd8a8bd610ffbcc9cc2b2bab58`.
- Candidate branch: `codex/report-center-rc6b-final-candidate`; the final candidate SHA is the published branch HEAD.
- Production and authoritative SHA remained `4a25cd49d373c442543af5063928daf73715bb55`.
- Production health remained `ok=true`, `env=prod`, `dbOk=true`, runtime SHA `4a25cd49d373`; database authority remained
  `budu_bj006`, migration ledger 58, failed migrations 0 and one writer at the verified gate baseline.
- Production was not written, migrated, deployed or merged. Candidate migrations 59–62 remain undeployed.

## Operating profit authority

- One `OperatingCostAuthority` now supplies the Profit page, Dashboard projection and complete server-side Excel export.
  Revenue continues to come from the RC-3 source resolver; legacy `DailyEntry.incCents - Expense.amountCents` is not used.
- Historical POS COGS is exclusively `OrderItem.costPriceSnapshot × quantity`, including gifts. Refunds do not reverse COGS
  and no inventory mutation occurs. Manual DailyEntry-only periods remain `INCOMPLETE_COGS`; no ratio or average-cost guess exists.
- Labor money is loaded from Payroll authority and allocated by stable employee identity plus actual hours. Wage, company social
  security, provident fund and other add-ons are separately projected, including explicit confirmed zero.
- Rent exposes contract mode, basis and bounded month allocation. Missing gross-sales basis fails closed. Utility exposes estimate,
  actual and difference; actual replaces estimate for computation without deleting the estimate. Expense remains other operating cost
  with duplicate-risk warning only and no text-based reclassification or deletion.
- Global and per-store results are `EXACT`, `ESTIMATED` or `INCOMPLETE`. Profit/margin are null when a key authority is incomplete.
  Current/partial periods and estimate-only utility remain estimated. Store ranking includes EXACT stores only; estimated and incomplete
  stores are separate groups.
- Profit previous/year comparison is emitted only when both periods are EXACT and the authorized store set is identical. A zero base
  returns no percentage; estimated/incomplete or mismatched coverage returns machine-readable `INCOMPARABLE`.
- Dashboard shows exact/estimated/incomplete profit truthfully and drills into the same Profit page. Excel has summary and cost/
  completeness sheets; incomplete profit cells are blank, never zero.

## Permissions, performance and UI

- Profit reads require both `REPORT_COST_VIEW` and `REPORT_LABOR_VIEW`; sales-only or cost-without-labor requests fail closed.
  Cost writes continue to require `REPORT_COST_MANAGE`, and store scope remains server-enforced.
- Profit aggregation is bounded by date range, stores and months. A 20-store fixture used one COGS aggregate, one each for rent,
  utility, labor-period and Expense, and one Payroll load for the month; there is no per-order, per-employee or per-day N+1 path.
- WebKit 320/340/375/390/430 and desktop projections passed with no horizontal overflow. Existing Overlay/PTR behavior remained
  covered by RC-4/RC-5 regression; RC-6B introduced no new overlay implementation.

## Final acceptance evidence

- Full Report Center RC-2A→RC-6B targeted suite: PASS.
- Isolated PostgreSQL migration rehearsals: 58→59 PASS, 58→59→60 PASS, and 58→59→60→61→62 PASS.
- Historical canonical reconciliation for Order, OrderItem, Payment, Refund, RefundItem, Transfer, Inventory, DailyEntry,
  DailyStoreStaff, PayrollNotice and Expense: PASS; no non-additive drift was observed.
- Payment, WeChat provider/reconciliation, unified refund, Daily Entry V2, Payroll, Transfer notification/quantity/actual shipment,
  and Purchase receiving targeted regressions: 78/78 PASS in the final cross-domain batch.
- Profit authority/migration/export fixtures, query-count tests, permission tests and RC-6B WebKit suite: PASS.
- Prisma validation, `git diff --check` and production build (2,905 modules): PASS.

## Remaining production blockers

- Independent Reviewer acceptance and an explicit Production Deployment Gate are still required.
- Production needs a fresh protected backup, disk/health/writer preflight, migration 59–62 rehearsal against a protected production
  snapshot, role-capability assignment approval, initial cost configuration and post-deploy reconciliation.
- Until those gates complete, Report Center V1 is candidate-ready but not live.

## Stop boundary

Stop after publishing this checkpoint. Do not migrate or deploy Production, merge authoritative mainline, assign Production
capabilities or enter real Production cost configuration without the next explicit gate.
