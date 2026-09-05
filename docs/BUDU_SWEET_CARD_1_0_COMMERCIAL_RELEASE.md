# budu Sweet Card 1.0 commercial release gate

Final decision: **COMMERCIAL_RELEASE_HOLD**.

Verified 2026-09-05, Asia/Shanghai. Model configuration is
`MODEL_CONFIGURATION_NOT_VERIFIABLE`; no model switch is claimed.

## Release closeout

- Core release tag: `sweet-card-v1.0.0`, annotated and pushed; it resolves to
  `02f3f8fb6431157378c583802075713dd8bde8ef`.
- P10C documentation commit `d0d1bad079a3b42b5032d4f2b49aca6a2a39a870`
  is included in the pushed `codex/sweet-card-p10c-concurrency` branch.
- Commercial access integration commit:
  `43a059bcf8eff0bc3ec553733e05fb676075aee7`, pushed on the same branch.
- Migration remains 64 applied / 0 failed. There is no Migration 65 or schema
  change. Balance, Ledger, redemption, settlement, refund, Payment and product
  eligibility logic did not change.
- The candidate and local build passed 57 targeted permission/Sweet Card tests,
  production build, exact-image validation and an unrouted read-only commercial
  access smoke.

## Skills

USED: `budu-task-router` (STRICT), `budu-context`, `budu-data-authority`,
`budu-payment-safety`, `budu-sweet-card`, `budu-production-deploy`,
`budu-regression`, and `budu-handoff`.

NOT_FOUND: dedicated repository skills named `release`, `permissions`, `audit`,
`reports`, or `POS`. The corresponding repository source, tests, authority and
deployment evidence were inspected directly. `budu-mobile-ui` and
`budu-brand-system` were NOT_APPLICABLE because no POS presentation change was
made.

## Production authority and backup

- Final routed runtime after hold rollback:
  `budu-prod-02f3f8f-sweet-card-p10c-xidan` at source
  `02f3f8fb6431157378c583802075713dd8bde8ef`.
- Canonical database: `budu_bj006`; Migration 64 applied / 0 failed; one writer;
  internal and public health pass.
- `CANONICAL_RESTORE_ARTIFACT`:
  `/opt/budu/.rollback-assets/sweet-card-p10c-02f3f8f-20260905/production-budu_bj006-m64-post-p19.dump`.
  It exists, both canonical SHA-256 checks pass, and its restore list contains
  6,100 entries. The protected `DO-NOT-RESTORE` marker for the two unrelated
  database `budu` dumps remains present.

The frozen artifact is the exact post-P19 backup and therefore predates the later
50,000-cent test card. It remains the designated P19 restore artifact, but it is
not a complete snapshot of the current database. No replacement was silently
promoted; that backup/current-facts gap is an additional release blocker.

## Commercial access candidate

The new application-only authority is `User.permissions.sweetCardPosRedeem`,
bound to stable authenticated `User.id`. Commercial access requires all of:

1. `SWEET_CARD_ENABLED`;
2. server-side `XIDAN_SWEET_CARD_COMMERCIAL`;
3. an eligible `Store.key` policy;
4. explicit `sweetCardPosRedeem` capability; and
5. the existing `store-pos` permission and order-store scope.

It does not grant issue, activate, void, freeze, replacement, blacklist, audit or
report authority. The P6A test allowlist remains a separate rollback path.

Three production candidates were read from PostgreSQL and verified with xidan
scope plus normal POS permission: `西单更新场` (`4e96854b…`, cashier), `陈文慧`
(`7bf092be…`, staff), and `王红云` (`f92d1e20…`, staff). Their commercial grants
were applied and audited for the candidate smoke, then revoked and audited when
the hold was declared. Final commercial-authorized operator count is **0**.

The commercial smoke itself passed: approved xidan operator available;
unapproved operator denied; another store denied; spoofed `operatorId` denied
with 403; Sweet Card admin API denied to an ordinary POS operator; authorized
admin access passed. Cash, WeChat and Alipay read-only regressions passed, and no
new provider charge or refund was initiated.

## Hold reason

Current PostgreSQL facts differ from the P19 release baseline. A third batch,
named and purposed `测试`, was created through the formal API at
2026-09-05 10:47:58 Asia/Shanghai by the approved developer principal. It contains
one CREATED, unactivated 50,000-cent card with no redemption or refund. This fact
predates the commercial capability grants and is preserved unchanged.

The resulting current reconciliation is ISSUE 50,150 - REDEEM 150 + REFUND 90 =
BALANCE 50,090 cents; Ledger sum 50,090 cents; unexplained delta 0. No negative
balance, duplicate economic effect or unauthorized economic success was found.
The P19 report's 150/90-cent baseline is therefore stale for current production.

The batch is canonically labeled as test data but is not one of the two P0-P19
acceptance batches and the current report contract has no formal commercial versus
acceptance classification field. In addition, batch `BUDU-SC-202609-A01` cannot
be created safely until an authorized business owner supplies the face value,
card count and recipients. The gate forbids inventing those inputs. Reporting and
first-batch prerequisites are therefore incomplete.

## Rollback and final scope

The commercial runtime was routed briefly only after its access smoke passed. On
discovery of the current-data conflict, the emergency hold procedure stopped it,
restored the previous runtime and nginx route, restored the pre-commercial host
environment, and reconciled one writer and healthy service. The commercial flag
is not active in the routed runtime. No card, order, refund, Ledger or audit row was
deleted or rewritten.

Final scope remains the controlled intersection `xidan + daa77021…`; all other
principals and stores remain denied. First-day commercial monitoring and Store
Expansion Gate have not started. The next gate must first establish the formal
classification/reporting authority for the additional test batch and receive the
approved `BUDU-SC-202609-A01` business inputs.
