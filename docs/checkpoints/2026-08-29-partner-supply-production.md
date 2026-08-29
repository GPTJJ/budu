# Partner Supply 1.0 — Production Checkpoint

Date: 2026-08-29 (Asia/Shanghai)

## Release authority

- Production code SHA: `f1aa19a22c51bcf7f08d9ec24437c8946be47aaa`
- Release branch: `codex/partner-supply`
- GitHub Actions run: `33224701650` — PASS
- Public health: `ok=true`, `env=prod`, `gitSha=f1aa19a22c51`, `dbOk=true`
- Canonical database: `budu_bj006`
- Migration ledger: `52 -> 53`

## Migration and data safety

- Migration `20260829043000_partner_supply` is additive and creates only `Partner`, `PartnerSupplyOrder`, `PartnerSupplyItem`, and `PartnerReceipt` authority tables, indexes, constraints, and foreign keys.
- A fresh migration-52 PostgreSQL custom-format backup and protected rollback copy were verified before migration.
- The explicit partner seed was reconciled as exactly one active `秦皇岛合作商`, stable ID `partner-qinhuangdao-v1`, default store `guanshe`, default discount `6500` basis points.
- Post-migration business fact counts were `orders=0`, `items=0`, `receipts=0`; no historical partner supply facts were fabricated.
- Existing transfer, purchase, mailing, invoice, and `InventoryItem` core digests were unchanged across migration and cutover.
- Production master facts remained `85` products / `26` materials, with `12` / `26` transfer-enabled.
- The module does not call stock balance or stock ledger write paths.
- Read-only candidate smoke passed before cutover; post-cutover writer count remained exactly one.

## Delivered behavior

- `合作商供货` is live between `申请采购` and `产品物料管理` with an independent permission key.
- Partner master data supports add, edit, default store, default discount, contact details, notes, and enable/disable; no physical delete route exists.
- New supply selection reuses active PostgreSQL `InventoryItem` products and `ProductCategory`; products without a valid `salePriceCents` cannot be selected.
- Orders freeze product ID/code/name/category, retail price, discount, partner unit price, quantity, and subtotal.
- Logistics and payment are separate: pending/shipped/withdrawn and unpaid/partial/settled/no-payment-required.
- Supply confirmation, pending withdrawal, append-only receipts, receipt void audit, overpayment prevention, and serializable concurrent-receipt protection are live.
- Historical orders remain readable after partner/product changes or disablement; withdrawn orders are preserved but excluded from receivable totals.
- Internal store-handler and creator notifications use stable usernames; no external partner account or notification was introduced.
- Details support a formal dynamic image and a three-sheet Excel reconciliation export: `合作商汇总`, `供货明细`, `收款明细`.

## Verification

- Isolated PostgreSQL 16 critical suite: `PASS 61 / FAIL 0`.
- Partner workflow covered price snapshots, multi-receipt settlement, voiding, concurrent overpayment rejection, shipment audit, withdrawal, disablement, history preservation, notifications, and zero stock side effects.
- WebKit release regression: PASS, including partner supply and existing transfer/invoice/mailing/customer-request flows.
- Partner mobile viewport regression: `320 / 340 / 375 / 390 / 430` — PASS with no horizontal overflow.
- Production build: PASS.
- Production migration, seed, historical digest, writer, nginx, and public health reconciliation: PASS.
- Independent public smoke: health SHA matches; unauthenticated partner routes return `401`; production lazy bundle contains partner title, order API route, and all three Excel sheet markers.

## Deployment note

- Initial run `33224481719` stopped before production access because an isolated workflow test found an invalid nested Prisma `orderId` argument.
- The minimal fix was committed as `f1aa19a`; the entire pipeline was rerun from the beginning and passed in run `33224701650`.

## Rollback

- Application rollback assets and the protected pre-migration backup were created by the authority-aware deployment helper.
- Migration 53 is additive; the previous application can ignore the new tables while rollback assets remain available.
