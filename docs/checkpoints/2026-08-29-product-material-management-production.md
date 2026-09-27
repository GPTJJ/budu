# Product / Material Management Production Checkpoint

Date: 2026-08-29 (Asia/Shanghai)

Status: **VERIFIED — deployed and reconciled**

## Release authority

- Release branch: `codex/product-material-management`
- Previous production SHA: `3f326ee46d82eab59444f4983fb0fa4ab9c8a2d8`
- Production runtime SHA: `4a957cbcba88b500f5c02f5d61df468767041ff3`
- Production environment: `prod`
- Canonical database: `budu_bj006`
- Migration ledger: `50 → 51`
- Added migration: `20260829010000_product_material_management`
- Deployment workflow: <https://github.com/GPTJJ/budu/actions/runs/33192951052>

The authority-aware deployment verified the existing runtime, database, migration
ledger, and exactly one application writer before starting. It then ran an
unrouted read-only candidate, stopped the old writer before starting the new
writer, switched nginx, and verified public health after cutover.

## Delivered contract

- Added **产品物料管理** immediately below **申请采购** in the 库存调拨 sidebar.
- Added separate 产品 and 物料 tabs with add, edit, transfer ordering, and
  enable/disable. No physical-delete API or UI exists.
- The page maintains basic transfer master data only; it does not expose stock,
  stock flow, purchase price, classification, or WMS features.
- Transfer availability and order use dedicated `transferEnabled` and
  `transferSortOrder` fields, so existing POS `isActive` and `sortOrder` authority
  is unchanged.
- New transfers read only enabled PostgreSQL master rows. The server rejects a
  stale or bypassed inactive item with HTTP 409.
- Existing transfer and purchase names are snapshotted before a master name edit;
  historical business facts remain readable after rename or disable.
- The mobile submit bar sits immediately above the global bottom navigation,
  includes iPhone safe-area offset, and the page reserves enough bottom padding
  for the final content row.

## Verification evidence

- Critical test gate: `PASS 56 / FAIL 0`.
- Product/material + Transfer + Invoice + Mailing + Customer Request WebKit:
  `46 passed`.
- Product/material migration rehearsal: passed against all 51 migrations.
- Notification integration: `16 passed / 0 failed`.
- Production build: passed.
- Responsive product/material and transfer coverage: 320, 340, 375, 390, and
  430 px with no horizontal overflow or bottom-bar overlap.
- Independent in-app browser visual QA at 390×900: passed; transfer content had
  160 px bottom padding and the fixed action bar ended where global navigation
  began.
- Public smoke after routing returned `env=prod`, `dbOk=true`, and runtime
  `4a957cbcba88`; the deployed dashboard and lazy product/material bundle both
  contained the new route and master-data API markers.

## Production reconciliation

The production migration seeded exactly the selector that existed before this
release:

- products: 85 total, 12 transfer-enabled, all 12 with transfer codes;
- materials: 26 total, all 26 transfer-enabled, none with a product code.

The deployment captured and compared historical TransferRequest,
PurchaseRequest, MailingRecord, and Invoice business digests before migration,
after migration, and after cutover. All remained unchanged. The InventoryItem
canonical core digest excluding the new additive transfer fields also remained
unchanged. No production business record was created for smoke testing.

## Backup and rollback

Before migration, the deployment created and integrity-checked the fresh custom
format backup `budu_bj006-migration50-pre-product-material-4a957cb.dump`, plus a
protected read-only copy under the release-specific
`.rollback-assets/product-material-4a957cb-*` directory. It also preserved the
previous nginx template, active nginx configuration, and production environment
file. Migration 51 is additive; the previous application remains compatible
with the new columns, while the database dump is retained for a confirmed data
integrity rollback.
