# Report Center V1 RC-2B Candidate

Evidence status: VERIFIED unless explicitly marked otherwise.

## Authority and scope

- Recovery base SHA: `62632729df2214005ca4853cc9d5a620f1ab2688`.
- Candidate branch: `codex/report-center-rc2b-candidate`.
- Production and authoritative SHA remained `4a25cd49d373c442543af5063928daf73715bb55`.
- Production authority remained `budu_bj006`, ledger 58, failed migrations 0 and one active writer.
- Production was read only. Migrations 59/60 were not applied to Production and no deployment occurred.
- Alipay Candidate `248607b83c74514376c29edd6aa56acdb24fad30` is not an ancestor and was not merged.

## Frozen authority implemented

- `Refund` / `RefundItem` remain the only refund authorities.
- `RefundMode` is `PAYMENT | MANUAL_EXTERNAL`.
- Database constraints and runtime validation enforce exactly one source:
  `paymentId XOR externalSettlementId`.
- Historical Refund rows backfill to `PAYMENT` without rewriting their financial or audit facts.
- Manual external refunds record an already-completed platform fact, require both explicit
  capabilities, preserve `externalCompletedAt`, and never enter a Payment provider.
- Deterministic BigInt allocation conserves every cent and enforces remaining settled amount and
  per-item quantity limits under an order-scoped transaction lock.
- Completed manual refunds derive ExternalSettlement and Order partial/full refund status.
- Refund completion does not write inventory, StockLedger, StockBalance or historical COGS snapshots.

## Migration and reconciliation evidence

- Clean isolated PostgreSQL 16 sequence 1→58→59→60: PASS.
- Production snapshot restore at ledger 58 followed by 59→60: PASS.
- Production snapshot after migration: 124 Orders, 190 OrderItems, 100 Payments, 5 Refunds,
  5 RefundItems, 24 TransferRequests, 176 TransferItems, 120 DailyEntries, 139 DailyStoreStaff and
  11 PayrollNotices.
- Order backfill invalid rows: 0; ExternalSettlement initial rows: 0; Refund backfill invalid rows: 0.
- Canonical pre/post combined digest remained
  `400d8af275681934b6e65f73f812fa7054cb24be2345adbb286db7de7f5c596e`.
- Production Migration 58 actual-shipment authority remained present.

## Regression evidence

- RC-2A workflow and Migration 59 rehearsal: PASS.
- RC-2B workflow, allocation and Migration 60 rehearsal: PASS.
- Manual external sources MEITUAN, TAOBAO_FLASH, JD_INSTANT and OTHER: PASS.
- Manual external provider invocation count, including refund query: 0.
- PAYMENT cash and WeChat partial/full/query/reconciliation regressions: PASS.
- Permission default-off, capability separation and same-store enforcement: PASS.
- COGS snapshot, InventoryItem, StockBalance and StockLedger before/after equality: PASS.
- Transfer Migration 58 and box/piece/actual shipment: PASS.
- Daily Entry V2, Payroll and orphan-dependency smoke: PASS.
- Prisma validation and application build: PASS.
- The broad `test:critical` entry still reaches the authoritative baseline's stale
  `test-payroll-shadow-calculator.mjs` expectation for an orphan DSS to emit
  `MISSING_DAILY_ENTRY`. The same assertion fails unchanged at exact Production SHA `4a25cd4`;
  the dedicated current Payroll resolver and orphan-dependency tests pass. This is VERIFIED
  pre-existing test debt, not Candidate regression, and was not modified in this gate.

## Stop boundary

RC-2B candidate is ready for independent review. Stop here: do not start RC-2C, deploy Production,
apply migrations 59/60, or expose platform order/refund UI without a new explicit gate.
