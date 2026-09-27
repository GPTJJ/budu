# POS Product Group — Production Checkpoint

Date: 2026-08-29 (Asia/Shanghai)

## Release authority

- Production code SHA: `aaa7dd39ac07e510de883565549a1dd8ec1f7c15`
- Release branch: `codex/unified-product-center`
- Successful GitHub Actions run: `33242945162` — PASS
- Public health: `ok=true`, `env=prod`, `gitSha=aaa7dd39ac07`, `dbOk=true`
- Canonical database: `budu_bj006`
- Migration ledger: `54 -> 55`

## Migration and data safety

- Migration `20260829180000_product_groups` is additive: it creates `ProductGroup` and adds nullable `InventoryItem.productGroupId` plus default-empty `variantName`.
- Existing products default to no group, so migration alone does not change POS grouping or any sale behavior.
- A fresh migration-55 PostgreSQL custom-format backup and protected rollback copy were verified before the successful cutover.
- Production default state at cutover was `0` groups / `0` grouped products / `0` named variants.
- Every pre-existing InventoryItem business field and all historical POS, transfer, purchase, mailing, invoice, and partner-supply facts were reconciled unchanged.
- Production master facts at cutover were `163` products / `26` materials / `27` transfer-enabled and coded products.
- ProductGroup never replaces InventoryItem identity. POS OrderItem, transfer, and partner supply continue to reference the real InventoryItem ID.
- Read-only Candidate passed before cutover; post-cutover database writer count remained exactly one.

## Delivered behavior

- Product Center now supports manual ProductGroup creation/editing, optional cover image, sorting, activation, member selection, and required per-member variant names.
- One InventoryItem can belong to at most one group; removing it from a group only clears display organization and never deletes the product.
- POS aggregates active groups at the first level, displays the minimum price with `起` only for mixed prices, and falls back to a member image when no group cover exists.
- The variant bottom sheet adds the selected real SKU to the cart and order.
- Group name, product name, variant name, SKU, and barcode search remain supported. A single matching/eligible variant is presented directly as a product.
- Ungrouped products and inactive groups continue to render as real products. Transfer and partner supply remain real-SKU workflows.

## Verification

- Migration rehearsals: `PASS 7 / FAIL 0`, including 54 -> 55 historical identity/reference preservation.
- ProductGroup real API workflow and Unified Product Center workflow: PASS.
- POS, Payment/Refund, transfer, and partner-supply targeted backend regression: `PASS 56 / FAIL 0`.
- Product Center, POS, material, transfer, and partner-supply WebKit suite: `PASS 69 / FAIL 0`.
- Mobile widths `320 / 340 / 375 / 390 / 430`, iPad WebKit, and desktop-width POS: PASS with no horizontal overflow.
- Production build: PASS.
- Independent public smoke: health SHA matched; unauthenticated ProductGroup, Product Center, and POS product APIs returned `401`; deployed POS/Product Center bundles contained ProductGroup and variant UI markers.

## Deployment notes

- Run `33241665851` applied migration 55, then stopped before Candidate/cutover because an InventoryItem digest included volatile `updatedAt` metadata.
- Run `33242235745` stopped before Candidate/cutover because a legacy gate hard-coded `12` transfer-enabled products while current production had `27`.
- Both fail-closed attempts left the old runtime healthy. The successful run used the current migration-55 authority, protected all product business fields and historical references, and replaced stale fixed counts with structural transfer-master integrity checks.

## Rollback

- Application, nginx, environment, and protected pre-cutover database backup assets were created by the authority-aware deployment helper.
- Migration 55 is additive; the prior application can ignore the new table and fields during an application rollback.
