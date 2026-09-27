# Report Center V1 RC-4 Candidate

Evidence status: VERIFIED unless explicitly marked otherwise.

## Authority and scope

- Base SHA: `323cdf8cb9aeb8f3d7ac7e58f17f0988cd951146`.
- Candidate branch: `codex/report-center-rc4-candidate`.
- Production and authoritative SHA remained `4a25cd49d373c442543af5063928daf73715bb55` at the gate baseline.
- Production authority remained `budu_bj006`, ledger 58, failed migrations 0 and one active writer at the gate baseline.
- Production was not written or deployed. Candidate migrations 59/60 were not applied to Production.
- RC-4 adds no Prisma schema or migration change; migration 61 was not created.

## Core report UX

- The existing `finance` navigation key now presents the Report Center shell while preserving the
  historical Finance/Expense capability under the “经营利润（历史能力）” entry. Transfer, partner-supply
  and payroll routes are reused rather than rebuilt.
- 综合营业 consumes the RC-3 daily-source resolver and exposes revenue, effective order count, range AOV,
  gross sales, discounts and refunds. Partial and unavailable facts are visually distinct from numeric zero.
- Channel and settlement composition use only Order/Payment/ExternalSettlement facts and carry the same
  coverage projection. Manual DailyEntry facts are never assigned a synthetic channel or settlement type.
- Store comparison is a server-projected Level-A revenue/order/AOV view; it does not average store AOV values.
- 订单明细 is server-paginated and server-filtered. Its drill-down reuses a shared read-only order detail
  component backed by a report-safe projection that omits product cost and unrelated sensitive fields.
- 商品销售 is server-aggregated and supports server search/ranking. All requested percentage denominators
  are calculated from the complete filtered result set; a zero denominator is returned and rendered as unavailable.
- Complete export is deliberately not exposed in this gate. The UI says export is pending instead of exporting
  only the current page and representing that partial file as a complete report.

## Responsive and overlay contract

- Mobile summary uses compact two-column metrics; orders use cards; products use compact cards with a
  detail overlay. Desktop retains report tables.
- WebKit coverage at 320/340/375/390/430 and desktop passed with no horizontal overflow.
- Coverage, order and product detail overlays use the global Overlay Stack; page pull-to-refresh is disabled
  while open and restored after the final overlay closes.

## Query and permission evidence

- Summary, order pagination and product aggregation remain server-side and range/store bounded.
- Fixed query-count assertions verify summary uses 3 model reads + 3 aggregate queries, while paginated orders
  and product aggregation each use 3 model reads + 1 aggregate query, independent of result count.
- Existing order/item/refund indexes were verified in the isolated PostgreSQL fixture; no migration 61 is needed.
- `REPORT_SALES_VIEW` gates the shell and every API. `REPORT_ALL_STORES` remains subordinate to report view,
  and server-side storeKeys enforcement is unchanged.

## Regression evidence

- Isolated PostgreSQL 16 migration chain 1→58→59→60 and RC-4 E2E: PASS.
- RC-2A and RC-2B migration rehearsals and RC-2A/RC-2B/RC-2C workflows: PASS.
- Payment foundation, WeChat provider/signature, reconciliation, cash and manual-external isolation: PASS.
- External provider invocation count remained 0; payment and refund authority paths were unchanged.
- Daily Entry V2 DB/API, Payroll authority/orphan dependency and Transfer box/piece/actual shipment smoke: PASS.
- RC-4 plus existing POS/refund/order/overlay/transfer WebKit regression: 59/59 PASS.
- Prisma validation, BigInt UI utilities, source/coverage tests, `git diff --check` and production build: PASS.
- Canonical DailyEntry, Order, OrderItem, Payment, Refund and RefundItem digest was unchanged by report reads.

## Known stale test debt

- The old `payroll-completeness-ux` fixture still expects a standalone DailyStoreStaff row without a
  DailyEntry to create a payroll completeness dependency. That expectation conflicts with the already-live
  orphan attendance hotfix. The current payroll authority and orphan-dependency tests pass; RC-4 does not
  modify Payroll code or data. The stale fixture was not weakened or rewritten within this gate.

## Stop boundary

RC-4 is ready for independent review. Stop here: do not deploy Production, apply migrations 59/60, merge
authoritative mainline or start a later Dashboard/profit gate without explicit authorization.
