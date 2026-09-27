# Sweet Card P7B Migration 64 candidate

Date: 2026-09-05 (Asia/Shanghai)

Status: `P7B_MIGRATION64_CANDIDATE_READY`

Model request evidence: `MODEL_CONFIGURATION_NOT_VERIFIABLE`. No claim is made that the runtime model was changed automatically.

## Authority and scope

- Exact production baseline: `48c28fb1bfa9d1109c2a4562b916d0d1abc92e32`.
- Production pre-candidate state: migration 63 applied / 0 failed, Sweet Card disabled.
- Canonical Sweet Card settlement amount: exactly one committed `sweet_card_redemptions.amount_cents` row per order.
- `sweet_card_ledger` and `sweet_card_redemption_items` are integrity/allocation proofs only and are not added to settlement coverage.
- Sweet Card remains an internal settlement authority. No Payment provider, fake Payment, dummy Payment, or Cash Payment is created for Sweet Card.
- Relational table/column/type change: **NO**.
- Production business data rewrite/backfill: **NO**.
- Database function/constraint object change: **YES**, limited to four existing functions and two existing Refund CHECK constraints.

## Files changed

- `prisma/migrations/20260905120000_sweet_card_settlement_refund_compatibility/migration.sql`
- `prisma/rollbacks/20260905120000_sweet_card_settlement_refund_compatibility.rollback.sql`
- `server/payments/payment-service.js`
- `scripts/p7b-m64-catalog-audit.mjs`
- `scripts/p7b-m64-db-matrix.sql`
- `scripts/test-p7b-m64-prisma-integration.mjs`
- this checkpoint

The application compatibility change only supplies the existing row-local provider/Sweet Card split at INSERT time for a pure Sweet Card refund, because PostgreSQL CHECK constraints are immediate. The normal refund allocator re-derives and validates the same split before completion.

## Exact SQL identity

- Migration: `20260905120000_sweet_card_settlement_refund_compatibility`
- Migration SQL SHA-256: `c6ef9010ec8c8b9b7736ed297525242841a7ffa1de234c64c6fa32fc7d82a17e`
- Rollback SQL SHA-256: `f9700eb3c757550baf117b8748ecaab3f2e5787c67ebadcee357169e97e9f32e`
- Exact forward SQL is the committed migration file; it contains four `CREATE OR REPLACE FUNCTION` statements plus the validated atomic replacement of exactly `refunds_source_xor` and `refunds_mode_source_contract`.
- Exact rollback SQL is the committed rollback file; it restores the production M63 function definitions/configuration and both original constraints.
- No `CREATE TABLE`, `ALTER TABLE ... ADD COLUMN`, `DROP COLUMN`, `CREATE TYPE`, business `UPDATE`, business `DELETE`, or backfill appears in the forward migration.

## Production M63 catalog baseline

All four functions were owned by `budu_bj006`, were `SECURITY INVOKER`, inherited `search_path`, and had default ACL semantics. `CREATE OR REPLACE` preserves owner and grants. M64 keeps `SECURITY INVOKER` and pins `search_path` to `pg_catalog, public`.

| Object | Before SHA-256 | Candidate SHA-256 |
| --- | --- | --- |
| `budu_guard_payment_authority()` | `d1271a89622b9589603872bf3ee4bfd4d87d65cdf4085fb91142f4c37a76b7d6` | `ec53cfb0e6306f7dbc3ef16355e9768463b99da01679e697d515708f26ee21b0` |
| `budu_guard_refund_authority()` | `33e5fdcd26e83f4f61d01f7a55879b728a7a1058efaceabc8ff9f52c0a25cd66` | `a59984e95f3adb5a1708b665580c775a2a1eda82b6200f5ceee96aced70745fd` |
| `budu_guard_settled_order_proof()` | `5a7a6fc2f09f4075902acc1351e4e154e2b3eedb1f5609d6b55943788e5625d4` | `e3bc32eccaac057aa40b16c3d20aa149a78a22da2853254a5334248936664b05` |
| `budu_validate_refund_contract(text)` | `2a9a200f3092f8a23aa1530804043af3274fc38c9ea5a14d46fda53b04fe9472` | `4ef28fe37e3b0b6b3904dfed3f1a944c3d97030e47ea5401aacd242334d92824` |
| `refunds_source_xor` | `eaf3a4be65d916cf233e55bd003ecc447e52a27b6b3a82ed2361884a1360ec69` | `d34309d381e93097baa97d6bfb46ec5ad6caa5ab21e5e9ef9a8f12c3bdfc7114` |
| `refunds_mode_source_contract` | `f07f30e528cdb8be77bb2b4a0c9dbadd27eaa4896dbea76e196d0f3834c2585c` | `2d4691afd181af44ebdfdc72458d364b9dbfddb87e87bd297f009b6addbbe356` |

The existing trigger references remain unchanged: `payments_authority_guard`, `orders_settled_proof_guard`, `refunds_authority_guard`, and the existing deferred Refund/RefundItem contract wrappers. Catalog dependencies remain the PL/pgSQL language and public namespace dependencies recorded by PostgreSQL; relation references are in PL/pgSQL bodies.

Rollback rehearsal restored all six before checksums exactly. Rollback is fail-closed once a valid M64-only source-free pure Sweet Card Refund exists; such financial rows must never be rewritten merely to make rollback pass.

## Constraint truth table

All cases passed on PostgreSQL 16:

- C1 Payment-backed Refund: ALLOW.
- C2 source-free non-Sweet Refund: DENY.
- C3 PAYMENT + ExternalSettlement only: DENY.
- C4 Manual External Refund: ALLOW.
- C5 Manual External + Payment only: DENY.
- C6 source-free pure Sweet Card Refund with explicit split: ALLOW.
- C7 malformed source-free Refund: DENY.
- C8 Payment + Sweet Card split for a valid mixed Refund: ALLOW.
- C9 legacy Payment Refund with null split: ALLOW.
- C10 unknown mode: DENY.

## Economic matrix

All E1-E16 passed:

- Payment-only exact coverage allowed; missing Payment denied.
- Pure Sweet Card exact coverage allowed with Payment count zero.
- rolled-back/incomplete Sweet Card proof denied.
- Sweet Card undercoverage, mixed underpayment, and mixed overcoverage denied.
- exact mixed 30-cent Sweet Card + 70-cent Payment coverage allowed.
- pending/failed Payment denied as settlement proof.
- ineligible allocation denied.
- duplicate Redemption rejected by stable order identity.
- legacy exact Payment behavior unchanged.
- pure Sweet Card full Refund allowed with exact rail facts.
- Sweet Card over-refund denied.
- mixed Refund rails remain isolated.
- duplicate Refund request produced one economic effect.

## Atomicity

- A1 forced late redemption failure: card balance unchanged; Redemption absent; REDEEM Ledger absent; allocation absent; order remained unpaid.
- A2 forced late Refund completion failure: card balance unchanged; Refund remained pending; REFUND Ledger absent; order remained paid.
- Real Prisma PaymentService test: pure Sweet Card Refund, mixed Refund, replay idempotency, and late coordinator failure all passed.

## Production-compatible clone

A fresh read-only logical dump of production migration 63 was restored into isolated PostgreSQL 16. Migration 64 applied successfully and validated all 173 historical Orders, 136 Payments, and 7 completed Refunds by replaying the guards and deferred contract inside a rolled-back transaction.

- M64 state on clone: 64 applied / 0 failed.
- Business data byte reconciliation (excluding `_prisma_migrations`): before and after SHA-256 both `0a67d321ca8243e6e17e4935387811c2669b30f64c122301fb50e63bae724c0d`.
- Columns, enums, indexes, non-target constraints, triggers, and non-target functions had identical before/after catalog digests.
- Candidate matrix on the production-compatible clone: 28/28 PASS.

## Regressions

- Build: PASS.
- Candidate server boot and health: PASS.
- Sweet Card core/migration/rollout/settlement: PASS.
- Payment foundation/reconciliation/access: PASS.
- POS core/order summary and legacy order protection: PASS.
- Cash paths: PASS.
- WeChat provider/signature/end-to-end/refund behavior: PASS.
- Alipay provider/config/callback and PostgreSQL integration/refund behavior: PASS.
- Refund and permission tests: PASS.
- Unified Product Center workflow: PASS.
- Report Center RC2A/RC2B/RC2C plus RC3 source contract: PASS.

Two unrelated pre-existing test harness defects were reproduced unchanged on the exact production image and excluded from candidate attribution: RC3 creates Orders on the current date but queries only 2026-08-31; an RC2C UI utility expects legacy uppercase `BUDU` while the production baseline returns the approved lowercase brand `budu`. A Product Center migration rehearsal also hard-codes an obsolete total migration count; the real Product Center PostgreSQL workflow passed.

## Production gate

No production migration or runtime change was made during candidate verification. Before production deployment, revalidate exact production SHA, migration 63/0, Sweet Card disabled, fresh backup integrity, rollback baseline, single writer, and health. Run legacy production verification before restoring only the approved `xidan + daa77021...` allowlist.
