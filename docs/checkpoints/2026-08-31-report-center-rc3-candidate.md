# Report Center V1 RC-3 Candidate

Evidence status: VERIFIED unless explicitly marked otherwise.

## Authority and scope

- Base SHA: `6e32eab77de958c3c5f618b4ad9fbfab84bb2bd8`.
- Candidate branch: `codex/report-center-rc3-candidate`.
- Production and authoritative SHA remained `4a25cd49d373c442543af5063928daf73715bb55`.
- Production authority remained `budu_bj006`, ledger 58, failed migrations 0 and one active writer.
- Production was read only. Candidate migrations 59/60 were not applied and no deployment occurred.
- RC-3 adds no Prisma schema or migration change; migration 61 was not created.
- No Report Dashboard or production UI was exposed.

## Production source audit

- Confirmed DailyEntry stores `incCents` as the current manually confirmed “营业收入” fact and
  `ord` as the confirmed order count. Draft entries are excluded.
- A confirmed DailyEntry is its historical daily source snapshot: `posSyncAt` distinguishes POS
  from manual, while immutable daily-confirmation audit metadata is used as a conflict check.
- Current Store source configuration is only a fallback for dates without a confirmed snapshot;
  it cannot rewrite confirmed history.
- Production contained 18 store-days where DailyEntry and Order rows coexist. The resolver chooses
  exactly one authority per store-day, so manual-day stray orders are not counted.
- Production had three manual stores and one POS store. Manual stores do not have authoritative
  gross, discount, refund, channel, settlement or item detail; those metrics remain PARTIAL or
  UNAVAILABLE rather than synthetic zero.

## Query authority and coverage

- A single server-side `ReportQueryService` owns date/store scope, authority selection, settled and
  effective order sets, refunds, gifts, discounts, BigInt aggregation, coverage and permission checks.
- Read-only APIs provide summary, paginated order rows/detail and paginated product metrics.
- Coverage DTO uses COMPLETE/PARTIAL/UNAVAILABLE plus covered, partial and uncovered stores,
  covered/uncovered store-day counts and reason codes.
- Level A accepts confirmed manual DailyEntry or POS authority. Levels B/C require POS Order and
  OrderItem facts. Missing authority returns null/unavailable, never zero.
- Settled sales retain completed, partially refunded and refunded orders. Effective-order
  denominators retain completed and partially refunded only. Completed refunds are attributed to
  the Order business date.
- Gross, discount, refund, revenue, channel/settlement composition and product metrics aggregate in
  PostgreSQL. API monetary/aggregate quantity values are decimal strings produced from BigInt.
- Queries are bounded to 92 days and 100 rows/page and use existing order, item and refund indexes;
  no migration 61 is required.

## Permissions

- `REPORT_SALES_VIEW` gates every report endpoint.
- `REPORT_ALL_STORES` is subordinate to report view; without it, server-side storeKeys filtering is
  mandatory and cross-store requests fail closed.
- Both capabilities default off for existing non-developer roles. Cashier/public roles cannot be
  granted them. No role received a production grant.

## Regression evidence

- Isolated PostgreSQL 16 complete migration chain 1→58→59→60 and RC-3 E2E: PASS.
- RC-2A and RC-2B migration rehearsals 58→59→60: PASS.
- Manual/POS source resolution, draft exclusion, no double-count, full/partial refund, gift,
  discount, channel/settlement, product metrics, scope, pagination and canonical digest: PASS.
- Payment foundation/reconciliation/WeChat/current Alipay state and provider-call isolation: PASS.
- Payment-log FK, cash/external settlement, Transfer box/piece and actual shipment: PASS.
- Daily Entry V2 and Payroll targeted smoke/regression: PASS.
- WebKit RC-2C + RC-3 capability projection: 13/13 PASS at 320/340/375/390/430 and iPad baseline.
- Prisma validation, source/unit tests, permission tests, `git diff --check` and build: PASS.
- Historical DailyEntry, Order, OrderItem, Payment, Refund and RefundItem canonical digests were
  unchanged by report queries.

## Stop boundary

RC-3 is ready for independent review. Stop here: do not deploy Production, apply migrations 59/60,
merge authoritative mainline, expose Report Center production UI, create migration 61 or start the
Report Dashboard gate without explicit authorization.
