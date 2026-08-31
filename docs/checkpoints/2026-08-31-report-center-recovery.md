# Report Center V1 Recovery Candidate

Evidence status: VERIFIED unless explicitly marked otherwise.

## Authority and scope

- Base authoritative SHA: `4a25cd49d373c442543af5063928daf73715bb55`.
- Recovery branch: `codex/report-center-recovery`.
- Historical RC-2A: `8b5a3416ff64e667f5ecd9e6867e50886a3e9f0a`.
- Historical RC-2B WIP checkpoint: `8198d7a6acd2c521ab10b34a77159980560ee933`.
- Production runtime remained `4a25cd49d373c442543af5063928daf73715bb55`; Production DB was read only.
- Production authority: `budu_bj006`, ledger 58, failed 0, one active writer, public/internal health PASS.
- Alipay Candidate `248607b83c74514376c29edd6aa56acdb24fad30` is not an ancestor and was not merged.

## Recovery mapping

- Production Migration 58 remains `20260830130000_transfer_actual_shipment` without modification.
- RC-2A is Recovery Migration 59:
  `20260831190000_report_center_order_source_external_settlement`.
- RC-2B WIP is Recovery Migration 60:
  `20260831193000_report_center_unified_refund_authority`.
- Migration rehearsal scripts, expected ledgers, Transfer historical rehearsals and checkpoint references
  were updated for the new order.

## Contract state

- RC-2A: recovered and regression-verified. `ExternalSettlement` remains separate from `Payment`;
  `PLATFORM`/`CUSTOM` external facts do not resolve or call a Payment provider.
- RC-2B: PARTIAL because the recovered source is explicitly a WIP checkpoint and has not received its
  independent RC-2B acceptance gate. Its current implementation and Migration 60 pass recovery tests,
  but this recovery must not be represented as RC-2B PASS.
- `RefundMode` is `PAYMENT | MANUAL_EXTERNAL`; both paths use the shared `Refund`/`RefundItem` authority.
- Report dashboard/query work has not started in this recovery gate.

## Rehearsal and reconciliation

- Full clean migration sequence 1→60: PASS in isolated PostgreSQL 16.
- Current Production snapshot restore 58→59→60: PASS.
- Snapshot backfill: 124 existing Orders mapped to `STORE_POS / POS_CHECKOUT / PAYMENT`;
  invalid mappings 0; ExternalSettlement rows 0.
- Five existing Refunds backfilled to `PAYMENT`; invalid refund backfills 0.
- Combined pre/post digest remained
  `400d8af275681934b6e65f73f812fa7054cb24be2345adbb286db7de7f5c596e`
  across Order, OrderItem, Payment, Refund, RefundItem, TransferRequest, TransferItem, DailyEntry,
  DailyStoreStaff and PayrollNotice.
- Production Migration 58 `shippedQuantity` authority remained present.

## Regression evidence

- RC-2A workflow and Migration 59 rehearsal: PASS.
- Recovered RC-2B workflow, allocation and Migration 60 rehearsal: PASS as recovery evidence only.
- Payment/POS/Refund/WeChat suites: 103 PASS.
- Cash settlement/refund path: PASS.
- External provider invocation count: 0.
- Transfer Migration 57/58 rehearsals and box/piece/actual-shipment workflow: PASS.
- Daily Entry V2 API and completeness smoke: PASS.
- Payroll resolver, payable-hours, readiness, orphan-dependency and integration smoke: PASS.
- Permission normalization and permission API: PASS; new high-risk capabilities remain default off.
- Prisma validation and application build: PASS.

## Stop boundary

Production was not changed and no Production migration was applied. Stop after publishing the recovery
candidate for reviewer inspection. Do not automatically continue RC-2B.
