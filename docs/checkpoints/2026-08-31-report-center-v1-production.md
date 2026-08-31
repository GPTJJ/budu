# Report Center V1 Production Deployment and Acceptance

Evidence status: VERIFIED unless explicitly marked otherwise.

## Authority and deployment

- Previous Production SHA: `4a25cd49d373c442543af5063928daf73715bb55`.
- Deployed runtime SHA: `0cd28684e6da8327ca37bd13d3b9ee05236bccaa`.
- Candidate branch at deployment: `codex/report-center-rc6b-final-candidate` at the exact deployed SHA.
- Authoritative mainline: `codex/budu-authoritative-mainline` fast-forwarded without force to the exact deployed SHA; ahead/behind `0/0`.
- Database authority: PostgreSQL `budu_bj006`.
- Migration ledger: 62, failed migrations 0. Migrations 59, 60, 61 and 62 were applied in order with reconciliation after each step.
- Runtime: `budu-prod-0cd2868-report-center`, image `budu-api:report-center-0cd2868`; public and internal health return
  `ok=true`, `env=prod`, `dbOk=true`, `gitSha=0cd28684e6da`.
- Canonical writer count after cutover: 1. The previous Production image and stopped container remain available for rollback.

## Backup and rollback

- Final quiesced pre-migration backup:
  `/opt/budu/.rollback-assets/report-center-0cd2868-20260831T124721Z/budu_bj006-migration58-pre-report-center-0cd2868-final-quiesced.dump`.
- Size: 36,851,640 bytes.
- SHA-256: `e382e50223d70400e4f115033d89103671674dc30fe1ebdef3110f0f71481354`.
- Protected copy checksum matched and `pg_restore --list` verification passed.
- Previous image/container, nginx configuration and protected environment/inspection evidence are retained in the rollback assets.
- Disk preflight passed; approximately 28 GB remained free after the exact candidate image build. No PostgreSQL volume,
  current/rollback image, protected backup or business file was deleted.

## Migration and historical reconciliation

- Migration 59 backfilled all 127 live legacy Orders to `STORE_POS / POS_CHECKOUT / PAYMENT` with nullable
  `sourceOrderRef`; Order amount, item, Payment, Refund, status, payment status, business date and provider identifiers were unchanged.
  Initial `ExternalSettlement` row count is 0.
- Migration 60 backfilled all 5 historical Refunds to `refundMode=PAYMENT`; source XOR, mode/source and item uniqueness guards passed.
  Refund amount and every historical RefundItem fact remained unchanged.
- Migration 61 created 118 initial current-cost history rows from existing InventoryItem current cost. All 196 historical
  `OrderItem.costPriceSnapshot` values and the historical COGS digest remained unchanged.
- Migration 62 created the operating-cost authority schema without guessing cost data. Initial rent, utility, labor-period and
  labor-add-on row counts are all 0.
- The final quiesced pre/post canonical digest is identical:
  `2abd7e7a58ebbad3e96dd787390f5a7e8d011d82f3651f5b67aedbc61717ab55`.
- Counts and canonical facts for Order, OrderItem, Payment, Refund, RefundItem, InventoryItem, Transfer/TransferItem,
  DailyEntry, DailyStoreStaff, PayrollNotice, Expense, PurchaseRequest/PurchaseItem, StockBalance and StockLedger are unchanged.
- Payment amounts/status/provider facts, Refund amounts, Order totals, Transfer quantities, actualHours and Payroll outputs are unchanged.

## Acceptance evidence

- Exact production-snapshot rehearsal `58 → 59 → 60 → 61 → 62`: PASS; snapshot canonical digest unchanged.
- Payment foundation: 21/21 PASS; payment reconciliation: 17/17 PASS. WeChat create/query/cancel/refund/reconciliation and
  cash settlement/refund contracts passed. The separate Alipay candidate is not an ancestor of this runtime and was not enabled.
- Manual external order/refund provider invocation count remains 0. No Production platform order or external refund was created.
- Daily Entry authority and Payroll orphan-dependency regression passed. Production DailyEntry/DailyStoreStaff/PayrollNotice digests are unchanged.
- Transfer functional regression: 24/24 PASS; production Transfer/TransferItem digest unchanged. One legacy 57→58 rehearsal assertion
  still hard-codes a final ledger count of 58 and reports the later candidate ledger as a mismatch; this is test debt, not a runtime or data regression.
- Purchase receiving workflow and atomic/idempotent receive regression passed; production Purchase/stock digests are unchanged.
- Build passed (2,905 modules). Production read-only query timings on the live dataset were: summary 92 ms, dashboard 183 ms,
  orders 38 ms, products 29 ms, profit 69 ms. Aggregation remains server-side and orders remain server-paginated.
- Production UI accepted: navigation label `报表中心`; Dashboard, comprehensive sales, Order report, product report and operating-profit
  projection all render from the new authority. Manual DailyEntry stores never receive fabricated Order/item/channel/settlement/COGS/profit facts.
- Today coverage correctly reports 2/4 stores available and marks Beijing Tongying Center and Beijing Xidan as pending close rather than zero.
- Chrome production checks at 320/340/375/390/430 showed no horizontal overflow. The 390px product-detail overlay locked page scrolling,
  retained the report content, and restored page scrolling after the last overlay closed. Candidate WebKit suites remain PASS.

## Permissions

- No broad default-role capability changes were written during deployment.
- Existing non-developer staff/cashier roles do not receive cost, labor, cost-management, external-order or manual-external-refund capabilities.
- New report/external capabilities resolve only for the existing minimal developer/admin boundary until the user explicitly authorizes role assignment.
- Service-side store scope and capability enforcement remain active.

## Current production cost completeness

For the verified August 2026 all-store period:

| Store | COGS | Rent | Utility | Labor | Operating Profit |
| --- | --- | --- | --- | --- | --- |
| 北京朝外店 | UNAVAILABLE / INCOMPLETE | MISSING | MISSING | INCOMPLETE | INCOMPLETE |
| 北京官舍店 | UNAVAILABLE / INCOMPLETE | MISSING | MISSING | INCOMPLETE | INCOMPLETE |
| 北京通盈中心店 | UNAVAILABLE / INCOMPLETE | MISSING | MISSING | INCOMPLETE | INCOMPLETE |
| 北京西单店 | UNAVAILABLE / INCOMPLETE | MISSING | MISSING | INCOMPLETE | INCOMPLETE |

Beijing Chaowai has partial OrderItem coverage for current sales, but not sufficient full-period COGS coverage. No rent, utility,
labor add-on or explicit-zero configuration was invented for acceptance. New operating profit therefore remains `INCOMPLETE`, with
known revenue/Expense facts still visible and profit null rather than zero.

## Stop boundary

Report Center V1 is Production LIVE. Stop after publishing this checkpoint. Do not grant additional roles, create real external
orders/refunds, enter cost assumptions, alter historical facts or start unrelated development without a new explicit gate.
