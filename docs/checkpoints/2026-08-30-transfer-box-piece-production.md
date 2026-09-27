# Transfer Box + Piece Units — Production Checkpoint

Date: 2026-08-30 (Asia/Shanghai)

## Release authority

- Status: **VERIFIED — LIVE**
- Production code SHA: `afc9df1baf038161743ec43f93ed6ac796d02393`
- Release branch: `codex/budu-authoritative-mainline`
- Public health: `ok=true`, `env=prod`, `gitSha=afc9df1baf03`, `dbOk=true`
- Canonical database: `budu_bj006`
- Migration ledger: `57`
- Additive migration: `20260830090000_transfer_box_piece_units`
- Production writer count: `1`

## Delivered behavior

- `InventoryItem.id` remains the product/material identity authority.
- Product Center allows administrators to configure box and piece transfer eligibility and positive gram specifications without name-based inference.
- Packaged transfer products store box and piece quantities as separate `TransferItem` rows with `quantityUnit=box|piece`; no box-to-piece conversion occurs.
- Unit weights are immutable transfer snapshots used only for displays explicitly marked `约`.
- Ordinary products and all historical rows retain the existing `quantity` behavior with `quantityUnit=legacy`.
- Transfer draft, selected list, review, detail, image export, and Excel export preserve actual box/piece units.
- Mobile transfer cards prioritize the product name; transfer code/SKU remains searchable without occupying the visual title.

## Data safety and migration

- Migration 57 is additive only: four optional/defaulted packaging fields on `InventoryItem`, plus unit and weight-snapshot fields on `TransferItem`.
- Existing transfer quantities were not rewritten. Post-migration production inspection found all 159 pre-existing `TransferItem` rows as `legacy`.
- A fresh verified custom-format backup exists at `.rollback-assets/product-group-afc9df1-20260830T035428Z/budu_bj006-migration56-pre-transfer-box-piece-afc9df1.dump`, with a protected copy.
- Historical transfer, purchase, mailing, invoice, product, partner-supply, and product-group authority digests remained unchanged across migration and cutover.
- Application rollback to the previous release is compatible with the additive schema; destructive schema rollback is neither required nor authorized.

## Verification

- Box-only, piece-only, mixed, zero rejection, per-item isolation, weight estimation, stable-ID submission, and legacy quantity workflow: PASS.
- Migration rehearsal 56→57 with historical-row digest preservation: PASS.
- Transfer/Product Center WebKit targeted suite: PASS 30/30.
- Mobile widths 320/340/375/390/430, iPad WebKit, safe-area, and horizontal overflow checks: PASS.
- Excel unit columns and image-export unit labels: PASS.
- Unified Product Center workflow and transfer authority contracts: PASS.
- Production build, unrouted read-only candidate, migration reconciliation, one-writer cutover, UI artifact, and public health: PASS.

## Operational note

- No production product was automatically classified as box/piece capable. Administrators must explicitly configure applicable products in Product Center.
- No production transfer, shipment, withdrawal, export, or other business write was created during smoke testing.
