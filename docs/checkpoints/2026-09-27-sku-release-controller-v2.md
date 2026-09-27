# SKU Authority 1.0 — schema-aware release controller candidate

Status: non-production Gate 8A-v2 engineering. This checkpoint does not authorize production deployment, schema migration, database write or public cutover. The future Gate 8 must independently verify the live baseline and receive explicit exact-SHA authorization.

## Immutable release identity

| Item | Pinned value |
| --- | --- |
| Production before | `5ad27a06d731fbc94de5ae3776060b4350b886e8`, `budu_bj006`, 85 applied / 0 failed, one writer |
| Approved business ancestor | `10d3c7ea5297fb0531ad59b20703ddba9d031bba` |
| Only schema transition | migration `20260927190000_sku_authority_candidate`, SHA-256 `d62859e9d2ba54f6dd847841f33a81c4ffb843ea653a7b15dddc6370c9b6fa2b`, 85 → 86 |
| Historical plan | 178 products, BD 89, TP 89, 33 missing old SKU, 145 aliases, 113 active; Gate 7 mapping digest `a939e90b70af125919abbc71ea461b2ec0c37773b0fda8e2da326d02451fab92` |
| Online baseline | 153 rows; exact identity digest `8042665cff559a5110a933e499137399d35cbce88dcb3f356f09825ca5924a86` |

The release SHA must descend from the approved business ancestor. The allowed engineering diff excludes business runtime, Prisma, dependencies and Dockerfile. All 85 prior migration files must match the production-baseline Git tree, the local repository must contain exactly 86 migration files, and the new SQL must match the pinned checksum. The existing `post-transfer` profile still rejects any Prisma diff with `SCHEMA_CHANGED`.

The candidate uses two exact-SHA images from the same reviewed source: the normal production runtime and a separate build-stage image containing the already locked Prisma CLI for `prisma migrate deploy`. The CLI is absent from the production runtime image because it is a devDependency. Both image archives receive source-payload and layer validation, and the admission budget conservatively includes both images. Migration SQL inside the loaded migration image is checked again before any writer is stopped. The migration image is only a one-shot worker and never serves public traffic.

## Rollback state and authority

`phase.json` is persisted under the release-specific rollback root using a same-directory atomic replace, file fsync and directory fsync. `PRE_CUTOVER` permits verified pre-migration database restore while the old writer is stopped and public routing still points to the old container. Backup checksum, isolated restore rehearsal and the exact 85/0 ledger are required. No release step starts while an unknown DB client or second writer exists.

Before the first public route write, the controller durably changes phase to `POST_CUTOVER`. Every exception handler reloads that manifest. From that barrier onward, the pre-migration backup is a disaster recovery asset only and cannot be used for automatic release rollback. Runtime failure first stops the candidate and proves writer zero, then independently reconciles the current 86/0 database. Only a reconciled DB permits old-application `SAFE_DEGRADED` startup, real Prisma SELECT 1, guard verification, one writer and restoration of the old route. A database-integrity failure enters `DATA_INTEGRITY_HOLD`: candidate stopped, writer zero, current DB retained, evidence retained, no automatic restore.

The 300-second observation is fully post-cutover. Public and internal health, application DB probe, writer count, migration ledger, SKU/online/historical reconciliation, restart count, Nginx 5xx and disk are checked during the window. The new current-SHA pointer is written only after the window succeeds.

Normal post-cutover business writes must survive application rollback. Reconciliation pins the original 178 product IDs/SKUs and 153 online external identities, while allowing new correctly allocated products, orders and other historical rows. Original snapshot rows remain immutable. New product allocation must still have a matching assignment, valid BD/TP SKU and a forward-only sequence. The old app's creation/name/SKU denial remains guarded by migration 86's PostgreSQL triggers.

## Non-production verification and future Gate 8

The push workflow `.github/workflows/sku-release-build-only.yml` has no production SSH, migration, or deployment step. It uses PostgreSQL 16 for Gate 8B compatibility, candidate authority tests, the release data adapter, Order and generic authority row preservation, plus pure rollback state-machine tests and an exact-SHA Docker build. The old `post-transfer` identity regression remains in CI.

The future production workflow routes to the SKU adapter only when the dispatch input is exactly `SKU_GATE_8`, the branch is `codex/sku-authority-release-controller-v2`, and `authorize_release_sha` equals the exact runner SHA. The existing dispatch path remains unchanged for all other inputs. Production Gate 8 must redo full current SHA, DB, writer, checksum, mapping, online identity, rollback image, disk, mount and real application DB-probe checks before any mutation. Production drift or a failed restore rehearsal blocks release.

Do not invoke the production adapter from this Gate 8A-v2 engineering run.
