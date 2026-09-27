# Report Center V1 RC-5 Candidate

Evidence status: VERIFIED unless explicitly marked otherwise.

## Authority and scope

- Base SHA: `2bc9e4bcf8cedd074bcb38489f2f93794b49d287`.
- Candidate branch: `codex/report-center-rc5-candidate`; the candidate SHA is the published branch HEAD.
- Production and authoritative SHA remained `4a25cd49d373c442543af5063928daf73715bb55` at the gate baseline.
- Production authority remained `budu_bj006`, ledger 58, failed migrations 0 and one active writer at the gate baseline.
- Production was not written or deployed. Candidate migrations 59/60 were not applied to Production.
- RC-5 changes neither Prisma schema nor migration history; migration 61 was not created.

## Dashboard authority

- The Dashboard is a single server projection built on the RC-3 query authority. It returns current metrics,
  freshness, per-metric comparisons, trend points, store comparison, channel/settlement composition and product
  TOP data without moving aggregation into the browser.
- Manual-store days still require confirmed DailyEntry facts. A missing or draft Manual DailyEntry on the server
  business date is `TODAY_PENDING_CLOSE`; an equivalent historical gap is `HISTORICAL_DATA_INCOMPLETE` or
  `HISTORICAL_DRAFT_ENTRY`. Future days are excluded as `FUTURE_NOT_OCCURRED`; none are converted to numeric zero.
- POS days continue to use settled Order authority. The existing POS/manual source resolver and no-double-count
  invariant are unchanged.
- Previous-period comparison uses the immediately adjacent equal span, with natural month-to-date clamping for
  the month preset. Year comparison uses the previous year's natural dates, including leap-day clamping.
- Every metric computes its own same-store intersection. COMPLETE, PARTIAL, INCOMPARABLE and NO_PRIOR_DATA are
  machine-readable; AOV is recomputed from period revenue divided by period effective orders, never averaged.
- Trend points are daily for up to 31 days, weekly through 62 days and monthly after that. Each point carries
  coverage. A mixed-source single day stays one cumulative daily point; no Manual-store hourly series is invented.
- Revenue/order/AOV store ranking uses Level-A facts. Channel and settlement composition still use real
  Order/Payment/ExternalSettlement facts, and product TOP uses real OrderItem facts. Partial coverage remains visible.
- The historical Finance calculation is not projected as operating profit. The Dashboard returns
  `PROFIT_MODEL_NOT_CONFIGURED` and renders no profit number.

## UI and permission contract

- The Report Center opens on the responsive 经营看板 while preserving all RC-4 views and drill-downs.
- Mobile uses compact two-column KPIs, one primary trend, store comparison, compact composition lists and product TOP;
  desktop uses a restrained three-row management layout.
- Coverage details reuse the global Overlay Stack, so page pull-to-refresh is disabled while the overlay is open and
  restored after it closes.
- `REPORT_SALES_VIEW`, `REPORT_ALL_STORES` and server-side `storeKeys` remain mandatory. Dashboard-specific 403 tests
  cover both missing report capability and out-of-scope store access.

## Performance and regression evidence

- Dashboard query count is fixed at 6 model reads + 4 aggregate queries for current summary, comparison summary and
  TOP products. It is independent of store/order/item result count and introduces no N+1 path.
- Isolated PostgreSQL 16 migration chain 1→58→59→60 and RC-5 data E2E: PASS. The suite covers today mixed sources,
  pending close, historical gaps, complete/partial/disjoint comparisons, no prior data, MoM, YoY, AOV, TOP products,
  permissions, provider isolation and canonical read-only reconciliation.
- Source/comparison/trend/BigInt UI tests: 10/10 PASS.
- RC-5 + RC-4 WebKit at 320/340/375/390/430 and iPad baseline: 17/17 PASS with no horizontal overflow; overlay/PTR PASS.
- Payment/refund foundation and reconciliation: 38/38 PASS. RC-2B and RC-2C workflow regressions PASS; external
  provider invocation remained 0.
- Daily Entry V2/Payroll regression and Transfer box/piece workflow: PASS.
- Canonical DailyEntry, Order, OrderItem, Payment, Refund and RefundItem digest was identical before/after report reads.
- `git diff --check` and production build (2,905 modules) PASS.

## Stop boundary

RC-5 is ready for independent review. Stop here: do not deploy Production, apply migrations 59/60, merge authoritative
mainline, expose the candidate in Production or start the operating-profit gate without explicit authorization.
