# SKU Authority 1.0 — Release Controller Gate 8A

Status: **NON-PRODUCTION RELEASE-ENGINEERING CANDIDATE**

This gate exists because the verified production controller correctly rejected the SKU candidate with `SCHEMA_CHANGED`. The existing `post-transfer` profile remains unchanged and continues to deny schema changes.

## Locked identity

- Production baseline: `5ad27a06d731fbc94de5ae3776060b4350b886e8`
- SKU business candidate: `829b91ba42656e9ad2db530dba68ba629b10364a`
- Approved migration: `20260927190000_sku_authority_candidate`
- Approved migration SHA-256: `c6c3c881b870c0dfaf639c0f1f9b34ece148c6baa49debafa6551feaa0f246f5`
- Migration ledger transition: **85 -> 86 only**
- Expected mapping: 178 products / BD 89 / TP 89 / legacy aliases 145 / missing old SKU 33
- Expected online mapping count: 153

Any second migration, changed migration byte, changed approved schema, changed SKU business runtime, missing business ancestry, or unknown release-engineering file is denied.

## Release state machine

1. Exact-SHA artifact build and identity verification.
2. Read-only production preflight: exact production SHA, DB, 85/0 ledger, writer=1, rollback image, disk guard, 178-product mapping and 153 online mappings.
3. Stop the current writer and verify writer count becomes zero.
4. Recompute the SKU mapping digest after writer drain.
5. Create a custom-format PostgreSQL backup and restore it into an isolated temporary database; require 85 migrations and 178 products.
6. Apply only the approved Prisma migration and require the exact 85 -> 86 ledger transition.
7. Run the deterministic 178-row SKU migration under Serializable transaction, with historical snapshot, product-ID set and online mapping reconciliation.
8. Require 178 current SKUs, BD89, TP89, assignments178, aliases145, missing0, sequences BD90/TP90.
9. Start the exact release image as the only application writer, verify container parity, real application DB SELECT 1, internal health and SKU/online reconciliation.
10. Switch nginx only after all candidate checks pass.
11. Observe production for 300 seconds with repeated public health, real DB probe and writer=1 checks.
12. Write the production SHA pointer only after the observation passes.

## Rollback authority

The old application is **not** assumed to be a valid application-only rollback after schema/data migration. Once the migration path starts, rollback authority is:

1. stop candidate / prove no writer;
2. restore the verified pre-migration database dump;
3. verify the 85-migration baseline;
4. start the old application;
5. verify old application real DB probe and writer=1;
6. restore route/pointer if touched.

No manual row edits are part of the rollback contract.

## Scope

Allowed Gate 8A changes are release controller, workflow, release tests and this checkpoint only. SKU business code, Prisma schema/migration SQL, Product Center behavior, Inventory 1.0 and mini-program identity are frozen.

Gate 8A does **not** authorize production deployment. Production remains unchanged until a separately reviewed exact release SHA is explicitly dispatched through the production workflow.
