# SKU Authority 1.0 — Gate 8A-v3 release controller checkpoint

Scope: non-production release engineering only. Production release and database migration remain on hold.

## Frozen authority

- Expected current production SHA for a future Gate 8 preflight: `5ad27a06d731fbc94de5ae3776060b4350b886e8`. This checkpoint does not claim a fresh production observation.
- Business runtime SHA: `10d3c7ea5297fb0531ad59b20703ddba9d031bba`.
- Migration: `20260927190000_sku_authority_candidate`, SHA-256 `d62859e9d2ba54f6dd847841f33a81c4ffb843ea653a7b15dddc6370c9b6fa2b`.
- Gate 7 extract: 178 product identities; 89 BD and 89 TP; 33 missing old SKU; 145 aliases; 153 online mappings.
- `InventoryItem.isActive` is POS/sales enablement: 87 true. The independent any-channel union of `isActive`, `transferEnabled`, `partnerSupplyEnabled`, and `partnerReplenishmentEnabled` is 113. The latter is a read-only drift diagnostic and does not affect SKU allocation or product snapshot serialization.
- Pinned mapping SHA-256: `a939e90b70af125919abbc71ea461b2ec0c37773b0fda8e2da326d02451fab92`.
- Pinned online identity SHA-256: `8042665cff559a5110a933e499137399d35cbce88dcb3f356f09825ca5924a86`.

## Release order

The adapter validates exact source and artifacts locally, then its first production-contact phase is read-only pre-mutation readiness. It checks the existing production SHA, current pointer, internal/public health, database and migration ledger, sole writer and unknown clients, old application Prisma `SELECT 1`, exact Gate 7 SKU and online identity, rollback image, disk and Docker resource model, and authority mount readability. SKU data comes from one read-only repeatable-read transaction in the running old application; the existing product planner generates the mapping digest. A failure here exits before release-lock creation, rollback-root creation, Docker load, writer stop, backup, or migration.

After exact artifact import and a second baseline check, the controller stops the old writer and confirms writer count zero. A final frozen candidate-image plan checks the exact readiness snapshot and channel digest, the pinned SKU and online digests, and all counts before creating the backup or beginning migration. A frozen-plan failure follows the pre-cutover rollback path and restarts the old writer without migrating.

The product snapshot shape and `snapshotId` calculation remain unchanged. No schema, migration, business runtime, product identity, SKU rule, historical snapshot, Inventory, POS, Partner, Transfer, or Mini Program behavior changes are part of this gate.

## Validation

The non-production V3 workflow uses PostgreSQL 16 for the release adapter, Gate 8B SAFE_DEGRADED, and lossless rollback rehearsals, then builds and inspects exact production-format artifacts without SSH or production access. Local Python/Node deterministic checks cover the Gate 7 extract, 87/113 semantic drift, mapping and online drift, zero mutation on readiness failure, frozen-plan ordering, old post-transfer schema denial, and release state-machine rollback. The exact CI run and controller commit must be recorded in the final Gate 8A-v3 handoff.
