# Unified Product Center — Production Checkpoint

Date: 2026-08-29 (Asia/Shanghai)

## Release authority

- Production code SHA: `d78e1e606e1451c6a83b8b359fb6253f78527af8`
- Release branch: `codex/unified-product-center`
- GitHub Actions run: `33231983302` — PASS
- Public health: `ok=true`, `env=prod`, `gitSha=d78e1e606e14`, `dbOk=true`
- Canonical database: `budu_bj006`
- Migration ledger: `53 -> 54`

## Migration and data safety

- Migration `20260829110000_unified_product_center` is additive: one non-null `InventoryItem.partnerSupplyEnabled` boolean with default `false`, plus one index.
- A fresh migration-53 PostgreSQL custom-format backup and protected rollback copy were verified before migration.
- Post-migration production facts were `85` products / `26` materials / `12` transfer-enabled products / `0` partner-enabled products.
- No product was automatically enabled for partner supply; administrators must opt in after setting a valid retail price.
- InventoryItem canonical core and historical transfer, purchase, mailing, invoice, and partner-supply digests were unchanged across migration and cutover.
- No InventoryItem ID was merged, replaced, deleted, or matched by name. Historical POS, transfer, and partner-supply references remain unchanged.
- Read-only Candidate passed before cutover; post-cutover database writer count remained exactly one.

## Delivered behavior

- `商品中心` is the single management entry for every PostgreSQL `InventoryItem` product, including the existing POS products and historical transfer-only products.
- POS eligibility continues to use the established `isActive` semantics and requires SKU, retail price, and cost price.
- Transfer eligibility continues to use `transferEnabled` and a stable SKU or transfer code.
- Partner-supply eligibility now uses only `partnerSupplyEnabled=true` plus positive `salePriceCents`; it no longer depends on `transferEnabled` or POS activation.
- `ProductCategory` is the single category authority consumed by POS, transfer, and partner supply.
- Search, category/use/status filters, compact list editing, and batch category/POS/transfer/partner operations are live.
- Inventory navigation now retains a material-only `物料管理`; product/category writes are protected by the Product Center management permission.
- Partner supply shows a precise Product Center guidance state when zero products have opted in.

## Verification

- Release critical suite: `PASS 63 / FAIL 0` on isolated PostgreSQL 16.
- Relevant WebKit release suite: `PASS 42 / FAIL 0`, covering Product Center, material management, partner supply, and store transfer.
- Unified product API workflow: stable ID editing, name-collision rejection, batch category/purpose updates, POS/transfer/partner eligibility, and no hidden product copy — PASS.
- Migration rehearsal: default opt-in false and historical POS/transfer/partner references unchanged — PASS.
- Mobile Product Center and related pages: `320 / 340 / 375 / 390 / 430` — PASS with no horizontal overflow.
- Production build: PASS.
- Independent public smoke: health SHA matches; unauthenticated product/category/partner-product APIs return `401`; current lazy bundles contain the unified Product Center, material-only management, independent partner switch, and explicit zero-product guidance.

## Deployment note

- Initial run `33231799987` stopped inside the isolated critical suite, before production access, because four older migration rehearsals expected total migration count 53.
- Their business-fact assertions had not failed. Expectations were advanced to 54, rerun locally (`4/4 PASS`), committed as `d78e1e6`, and the complete production pipeline then passed from the beginning.

## Rollback

- Application, nginx, environment, and protected pre-migration database backup assets were created by the authority-aware deployment helper.
- Migration 54 is additive and defaults off; the previous application can ignore the new column during an application rollback.
