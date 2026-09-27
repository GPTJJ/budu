# Product Category & Transfer Summary — Production Checkpoint

Date: 2026-08-29 (Asia/Shanghai)

## Release authority

- Production code SHA: `92a736a84f6e4ff9a745467633cb5b4b863edf4f`
- Release branch: `codex/product-category-transfer-summary`
- GitHub Actions run: `33197394710` — PASS
- Public health: `ok=true`, `env=prod`, `gitSha=92a736a84f6e`, `dbOk=true`
- Canonical database: `budu_bj006`
- Migration ledger: `51 -> 52`

## Migration and data safety

- Migration `20260829030000_product_category_transfer_summary` is additive.
- A fresh migration-51 PostgreSQL custom-format backup and protected rollback copy were verified before migration.
- Existing products were not inferred or classified: `categories=0`, `classifiedProducts=0`.
- Existing transfer history was not reclassified: `classifiedHistoricalItems=0`.
- Production master facts remained `85` products / `26` materials, with `12` / `26` transfer-enabled.
- Transfer, purchase, mailing, invoice, and InventoryItem core digests were unchanged across migration and cutover.
- Read-only candidate smoke passed before cutover; post-cutover writer count remained exactly one.

## Delivered behavior

- PostgreSQL `ProductCategory` is the single category authority for product administration and new transfer selection.
- Category add/edit/sort/enable-disable, product category editing, search/filtering, and batch categorization/unclassification are live.
- Existing products remain in the system `未分类` bucket until explicitly assigned.
- Disabled products remain visible in history but are excluded from new transfers.
- New transfers snapshot the product category name; historical rows retain their original blank/unclassified fact.
- Transfer Excel export supports shipped-time date range, store multi-select, product/material filter, per-store inbound/outbound/net aggregation, and exactly two sheets: `调拨汇总` and `调拨明细`.

## Verification

- Isolated PostgreSQL 16 critical suite: `PASS 58 / FAIL 0`.
- WebKit regression suite: `51 passed`.
- Production build: PASS.
- Production migration and authority reconciliation: PASS.
- Independent public bundle markers and authenticated API route smoke: PASS.

## Rollback

- Application rollback assets and the protected pre-migration backup were created by the authority-aware deployment helper.
- Migration is additive; rollback of application code does not require deleting the new table or columns.
