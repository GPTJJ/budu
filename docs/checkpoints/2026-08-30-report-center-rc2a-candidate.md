# Report Center RC-2A Candidate Checkpoint

Evidence status: VERIFIED unless explicitly stated otherwise.

> Recovery note (2026-08-31): this document records the historical RC-2A gate. Its never-deployed
> Migration 58 has been renumbered to Recovery Migration 59
> (`20260831190000_report_center_order_source_external_settlement`) because Production Migration 58
> is now `20260830130000_transfer_actual_shipment`. The historical rehearsal counts below remain
> historical evidence; current recovery evidence lives in
> `2026-08-31-report-center-recovery.md`.

## Scope and authority

- Base: `codex/budu-authoritative-mainline` at `3c4b4baab7226764ec44d7c9769882368001981f`.
- Candidate branch: `codex/report-center-rc2a` (candidate commit is the branch HEAD containing this checkpoint).
- Production authority remained `budu_bj006`, with one active writer and migration ledger 57.
- Alipay Candidate `248607b83c74514376c29edd6aa56acdb24fad30` was not read or merged.
- No production deployment, migration, schema write, or business-data write was performed.

## Candidate contract

- Historical Candidate Migration 58, now Recovery Migration 59, adds `OrderSource`, `EntryMode`, `SettlementAuthority`, nullable `sourceOrderRef`, and the one-to-one `ExternalSettlement` authority.
- Existing orders backfill to `STORE_POS / POS_CHECKOUT / PAYMENT`, independent of row count.
- `MEITUAN`, `TAOBAO_FLASH`, and `JD_INSTANT` map to `MANUAL_POS / EXTERNAL / PLATFORM`; `OTHER` maps to `MANUAL_POS / EXTERNAL / CUSTOM`.
- Payment and ExternalSettlement are mutually exclusive at service and database boundaries. Settled orders require exactly one authority-matching, amount-matching proof.
- External settlement amount is `BIGINT`; API serialization and confirmation use decimal strings.
- Only `SettlementCoordinator` derives settled Order status, paymentStatus, payment metadata, and completedAt from a verified Payment or confirmed ExternalSettlement fact.
- Capabilities `externalOrderCreate` and `externalSettlementConfirm` are independent and default off for non-developers. Cashier/public accounts cannot receive them.
- Normal POS UI contains no platform order controls. Manual external refund remains intentionally unavailable.

## Rehearsal and reconciliation

- Synthetic 57→58 migration rehearsal: PASS; legacy WeChat, cash, and refunded facts were unchanged.
- Fresh production snapshot SHA-256: `9c5391524b8f2521363c85490f3f57be0c98a2ec6879a0f44de7c5fca77997ed`.
- Fresh snapshot before migration: ledger 57; 112 orders (`cancelled:22, completed:87, refunded:3`).
- Fresh snapshot after isolated migration: ledger 58; 112 orders; zero ExternalSettlement rows; zero invalid backfills.
- Canonical Order, OrderItem, Payment, Refund, and RefundItem digests matched before/after.
- Migration 57 transfer unit columns remained present (6/6).
- Production post-rehearsal: health SHA `3c4b4baab722`; ledger 57; `external_settlements` absent.

## Verification

- RC-2A external workflow: PASS (all four sources, confirm, idempotency, concurrency, BigInt, permissions, store scope, DB guards, provider call count zero, cash regression, UI non-exposure).
- The historical Migration 58 isolated suites passed; the renumbered Migration 59 is re-verified by the recovery gate.
- Payment foundation: 20/20 PASS.
- WeChat provider: 23/23 PASS.
- WeChat reconciliation: 17/17 PASS.
- WeChat configuration: 9/9 PASS.
- WeChat E2E: 9/9 PASS.
- POS core: 10/10 PASS; POS summary: 3/3 PASS; account permissions: 11/11 PASS.
- Production build: PASS.

## Rollback and remaining boundary

- Before any future production application, take a new protected `budu_bj006` backup and repeat current-state reconciliation.
- Pre-deployment rollback is branch abandonment. If Recovery Migration 59 is ever applied but no ExternalSettlement business rows exist, rollback is the reviewed reverse DDL for the new triggers/functions/table/indexes/columns/enums plus restore-on-mismatch. Once external facts exist, schema rollback is forbidden; roll forward or restore the protected pre-migration database.
- Unified Refund / Manual External Refund is the next required gate before platform POS UI can be enabled. Dashboard and operating-profit work have not started.
