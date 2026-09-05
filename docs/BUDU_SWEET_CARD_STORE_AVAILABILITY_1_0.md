# Sweet Card Store Availability 1.0

Date: 2026-09-05. MODEL_CONFIGURATION_NOT_VERIFIABLE.

## Evidence and authorization

SWEET_CARD_STORE_AVAILABILITY_1_0_COMPLETE. Candidate, production promotion, final expansion and reconciliation VERIFIED at 2026-09-05 07:35 UTC. The user explicitly authorized production after candidate PASS and enabling all current ACTIVE DIRECT stores in sections 35–36. The user's business confirmation is: tongying, chaowai, guanshe and xidan are all DIRECT. No inference from names or existing eligibility is used.

Production baseline directly audited over SSH: SHA `1d0899ac3b576f5a8045e49a929b4cf3939add35`, runtime `budu-prod-1d0899a-sweet-card-data-org`, database `budu_bj006`, migration 66 applied / 0 failed, health/db PASS, one production writer. Environment `SWEET_CARD_ENABLED=1`, `XIDAN_SWEET_CARD_COMMERCIAL=1`. Current four Store rows are active and existing per-store policies eligible=true. Prior backup is retained at `/opt/budu/.rollback-assets/sweet-card-data-org-1d0899a-20260905T063746Z/current-canonical-budu_bj006-m66-data-organization.dump`, SHA256 `cd9283c929d0dc17c768c2dea92b1ed2a896f8d08386d11f77ba9083c7aef374`.

## Skills-first

| Skill | Discovery | Applicability | Use | Gate |
|---|---|---|---|---|
| budu-task-router | FOUND | APPLICABLE | USED | Scope / STRICT routing |
| budu-context | FOUND | APPLICABLE | USED | Recovery / current authority |
| budu-sweet-card | FOUND | APPLICABLE | USED | Business contract / economic boundaries |
| budu-data-authority | FOUND | APPLICABLE | USED | Store identity / policy reuse |
| budu-payment-safety | FOUND | APPLICABLE | USED | STRICT refund / transaction validation |
| budu-regression | FOUND | APPLICABLE | USED | Candidate and post-deploy regression |
| budu-production-deploy | FOUND | APPLICABLE | USED | Backup / exact SHA / rollback / one writer |
| budu-handoff | FOUND | APPLICABLE | USED | Final evidence and status |
| budu-mobile-ui | FOUND | APPLICABLE | USED | Chinese UI / responsive checks |
| budu-brand-system | FOUND | APPLICABLE | USED | Existing visual language |
| playwright | FOUND | APPLICABLE | USED | UI interaction / screenshots |
| Dedicated Store, POS permission, permissions, audit, feature/config, Prisma/migration skills | NOT_FOUND | APPLICABLE domains | NOT_USED as separate skills | Covered by authority, Sweet Card, payment, regression and deployment skills |

## Canonical authorities

- Store identity: PostgreSQL `Store.key`; active status: `Store.active`.
- Business classification: new `Store.operationType` enum UNKNOWN / DIRECT / NON_DIRECT. Default UNKNOWN denies. The four existing rows are classified only in an audited, explicit release configuration transaction backed by the user's confirmation.
- Per-store switch: **reuse** `SweetCardStorePolicy.eligible`, primary key/FK `storeId → Store.key`. No second per-store table. Missing row denies.
- Runtime emergency switch: singleton PostgreSQL `SweetCardControl.GLOBAL.enabled`, default false, combined with the preserved existing environment flags as an outer safety ceiling. Ordinary admin switching needs no restart/deploy. OFF retains per-store configuration.
- Minimal additive migration **67**, necessary because direct/non-direct and mutable PostgreSQL global control had no safe existing fields. No economic schema or Migration 64/65 functions changed. No purpose/balance/history backfill.
- Normal POS authority: current authenticated PostgreSQL User, existing `hasModuleAccess(STORE_POS)`, and existing superuser/storeKeys scope rules. Cashier role has POS intrinsically under the pre-existing resolver; its scope removal/account disabling revokes store access. Staff module grants/removals take immediate effect. No new permission resolver or synchronization list.
- Legacy `sweetCardPosRedeem` and P6A grant data/audits preserved. `LEGACY / NOT_AUTHORITATIVE_FOR_POS_REDEMPTION`. Legacy helper file retained for historical regression; current runtime POS/redemption routes do not call it. Obsolete extra-grant writer returns 410. No xidan hardcode in the new decision path.
- Management remains module Sweet Card plus existing dedicated capability. Ordinary POS cannot issue, create batches, activate, void, freeze, bind, lose/replace cards, configure stores/global/blacklist or read sensitive reports.

New redemption checks occur inside the original Serializable economic transaction before debit, with shared locks on global config, Store, existing policy and current User. A concurrent disable/revoke cannot slip between the final authorization and commit. Raw row-lock SQLSTATE 40001/40P01 is surfaced as a controlled 409 in the new availability layer; original P2034 helper and retry policy are unchanged. Each successful redemption audit records its authorization snapshot without credentials.

Historical refunds, existing mixed payment completion and cancellation recovery use the original POS scope and existing Order/Settlement/Refund/Ledger services independently of the new switches. No provider, state machine, balance computation, allocation, blacklist algorithm or settlement implementation changes.

Old rules writer can no longer bypass the DIRECT policy; category updates remain supported. New store/global and batch configuration writes and their previous/new audit values commit in one transaction.

## Candidate verification

VERIFIED:

- Build PASS; Sweet Card 49 tests PASS; 155 POS / Cash / payment foundation / WeChat signature, provider, payment/refund / Alipay provider, callback, payment/refund / reconciliation / permissions / item category / settlement tests PASS. Provider tests use existing synthetic transport and do not charge real accounts.
- Existing Sweet Card data organization isolated PGlite migration/contract PASS.
- Existing management UI browser regression: 7 PASS (including 320, 340, 375, 390, 430 px).
- New availability UI: desktop and 320/340/375/390/430/1024/1440 widths no horizontal overflow; individual confirmation, global emergency confirmation, preserved switches under Global OFF, Chinese labels, locked non-direct and inactive stores PASS.
- Real PostgreSQL 16 restored production-compatible database `budu_sc_availability_isolated`, migrated 66→67. Fixtures are exclusively new ACCEPTANCE_TEST cards. Production cards/orders never used for economic smoke.
- Real API A–R matrix PASS: normal POS without legacy grant; no POS; disabled store; revoke/grant on current DB; non-direct/inactive/unknown; global OFF; re-enable; spoof operator/store; outside scope; management separation; batch ACTIVE DIRECT only; new direct no-policy deny; all switches leave financial facts unchanged.
- Both global-OFF and store-OFF historical full-card Refund through the original API PASS, repeated refund request produces exactly one Ledger credit, restores 100 cents, full delta 0.
- Product classification/blacklist real API DENY with zero economic effect; inspect API ALLOW with normal POS.
- Controlled concurrent disable returns 409, next request 403, no partial effect; duplicate concurrent redemption returns 201/200 with one committed redemption/debit.

UI artifacts: `output/playwright/store-availability-desktop.png`, `output/playwright/store-availability-mobile.png` (explicitly labeled isolated examples).

## Production plan and rollback

Use `scripts/deploy-prod-sweet-card-availability.sh`, adapted from the current verified data-organization release script, and the unchanged container cloner. Exact commit → normal branch push → Git bundle → immutable image. The script rechecks old SHA, database, migrations, flags, writer, creates a fresh M66 custom dump, verifies listing/SHA, restores an isolated database and re-runs the complete API matrix before production migration.

Apply additive M67, initialize the four verified DIRECT classifications and global ON while preserving existing per-store values; verify economic/payment digests unchanged. Run unrouted read-only candidate acceptance; retain an executable rollback before stopping the old writer. Switch only after candidate health and all required gates; verify public health, per-store current POS authority and denial-only spoof probes, reports, full reconciliation and one writer. Audit the final all-ACTIVE-DIRECT expansion. No commercial card issuance.

Rollback restores the prior application/container/nginx route and preserves M67 additive columns/table. Old application ignores them; existing economic facts and store eligibility remain unchanged. Do not restore a pre-cutover database over subsequent business transactions. A P0 safety halt uses global OFF first; application rollback is a separately assessed recovery action.

New M67 canonical backup and final runtime evidence are recorded below. All prior artifacts, P19 acceptance baseline, and DO-NOT-RESTORE dumps remain retained with their existing designations.

## Monitoring

`monitor-sweet-card-availability.mjs` checks all facts and enabled stores in a consistent DB snapshot: negative balances, per-account/full Ledger delta, duplicate identities/effects, new authorization snapshots, Sweet Card refund failures. Default read-only; explicit `--halt-on-p0` atomically sets global OFF with audit on a redline. No balance/ledger adjustment. Existing legacy redemptions are reported separately; their historical authorization is not inferred from current permissions. The existing monitoring heartbeat was updated after deployment to cover all enabled direct stores, HTTP 5xx/409, credential errors and refund failures, preserving quiet-on-no-change behavior.


## Final production evidence — VERIFIED

- Deployed SHA: `3838b35b6e2abd2196a8183901462329d610636b`.
- Runtime: `budu-prod-3838b35-sweet-card-availability`; nginx switched at `2026-09-05T07:34:16Z`.
- Exact image revision, runtime GIT_SHA and `/opt/budu/.current-sha` agree. Public `/api/health` returns `ok=true`, `dbOk=true`, `gitSha=3838b35b6e2a`.
- Database `budu_bj006`; **67 applied / 0 failed**; exactly **1 writer**.
- Current direct stores **4**; Sweet Card enabled stores **4**; non-direct enabled **0**. GLOBAL **ENABLED**, preserved environment flags both `1`. Per-store control **AVAILABLE**.
- Automatic normal POS redemption **PASS**; additional redeem permission required **NO**; Sweet Card admin capabilities **SEPARATE / PASS**.

| Store key | Store | Classification evidence | Type / enabled | Current POS operators | Authorized | No POS scope for this store | Spoof operator/store |
|---|---|---|---|---:|---|---|---|
| tongying | 北京通盈中心店 | User explicitly confirmed DIRECT | DIRECT / ENABLED | 7 | ALLOW | 403 | 403 / 403 |
| chaowai | 北京朝外店 | User explicitly confirmed DIRECT | DIRECT / ENABLED | 11 | ALLOW | 403 | 403 / 403 |
| guanshe | 北京官舍店 | User explicitly confirmed DIRECT | DIRECT / ENABLED | 6 | ALLOW | 403 | 403 / 403 |
| xidan | 北京西单店 | User explicitly confirmed DIRECT | DIRECT / ENABLED | 6 | ALLOW | 403 | 403 / 403 |

The production authority probe used current authenticated accounts and live POS configuration. Denial-only POST probes against existing orders used deliberately invalid tokens and were rejected **before** credential processing or any economic effect. Current active non-public production accounts all have the POS module; therefore the verifier's separate `noPos` (module absent globally) field is UNVERIFIED in production because no such active account exists. This is not a permission bypass: actual accounts without the target store's POS scope were directly verified 403 in **each** store. The module-absent, grant and revoke cases were independently VERIFIED by real APIs against PostgreSQL acceptance accounts, without changing any production user's permissions.

Cash, WeChat and Alipay configuration remains enabled for all four production stores. Provider implementation unchanged; provider payment/refund regression uses controlled synthetic transport, not live merchant charges. Reports, blacklist/rules, ordinary POS management denial, reconciliation, health and DB probes PASS.

### Financial facts — unchanged

ISSUE **400150** − REDEEM **160** + REFUND **100** = BALANCE **400090 cents**.

- Full Ledger: **400090 cents**; full and per-account delta **0**.
- COMMERCIAL: 11 cards, outstanding **250000 cents**, redeemed/refunded **0**.
- ACCEPTANCE_TEST: 5 cards, outstanding **150090 cents**.
- 16 total accounts, 29 Ledger rows, 9 Redemptions, 4 Sweet Card Refunds remain unchanged.
- Full economic digest before/after: `367cb2c54abea909af01e3c710fa8ab5531ad2a9628250e1597865d620b8eff3`.
- Payment provider/status summary and refund count unchanged. No production card issuance, redemption, refund, balance adjustment or history deletion was performed by this release.
- Config operations audited: four verified Store classifications, global initialization, four per-store enable confirmations, one all-direct enable operation. Previous eligible=true records were preserved and confirmed, not duplicated into another authority.

### Current canonical backup and rollback

`CURRENT_CANONICAL_RESTORE_ARTIFACT`:

`/opt/budu/.rollback-assets/sweet-card-availability-3838b35-20260905T073120Z/current-canonical-budu_bj006-m67-store-availability.dump`

SHA-256: `227ee02340969b43478ed422a9e16327e3d5dc2c235f6c081114455d683e605f`.

Dump exists; source DB identity **budu_bj006** checked before dump; restore listing **6107 entries**; actual isolated restore identity `budu_restore_m67|67|0|7|0` (67 successful migrations, no failures, 7 batches, no newly archived batches). CHECKSUM / LISTING / RESTORE **PASS**.

Executable application rollback:

`/opt/budu/.rollback-assets/sweet-card-availability-3838b35-20260905T073120Z/rollback-app.sh`

Previous application `1d0899ac3b576f5a8045e49a929b4cf3939add35` remains stopped and retained. Additive M67 is compatible with it. No database downgrade/deletion is required for application rollback. Global OFF protection must be explicitly preserved before any rollback to the old application, which does not read the new DB global field.

The first production gate stopped before cutover on a bundle HEAD issue. After that was fixed, M67 applied successfully but the bounded initialization container lacked the database network; it failed before any classification/global write. The old application stayed healthy, classifications/control remained empty, balance/Ledger stayed 400090. Network inheritance and early-failure cleanup were corrected, all gates re-run. The first pre-migration M66 backup remains retained:

`/opt/budu/.rollback-assets/sweet-card-availability-5c1ac6b-20260905T072615Z/pre-promotion-budu_bj006-m66.dump`.

The successful continuation created a fresh M67 pre-promotion backup before configuration. These resolved deployment failures did not change production economic facts.

### Post-deploy monitoring / UI

Direct initial check: negative balances **0**, duplicate economic effects **0**, new unauthorized-success snapshots **0**, failed Sweet Card refunds **0**, account deltas **0**, P0 **false**. All 9 existing redemptions predate the new authorization snapshot; no historical authorization claim is inferred from current permissions.

Fresh runtime log aggregate at final audit: HTTP 5xx **0**, HTTP 409 **0**, 14 expected 403 denial probes among 35 logged requests. This is a bounded initial observation, not a future availability guarantee.

Existing heartbeat `automation` updated to **甜意卡四店首日监控**, every 15 minutes, ACTIVE; keeps quiet unless actionable, covers dynamically enabled stores, and can halt new redemption through audited DB GLOBAL OFF on confirmed P0. Original first-business-day cutoff is preserved.

New UI also passed WebKit at 320/340/375/390/430/1024/1440 widths; iPad screenshot `output/playwright/store-availability-ipad-webkit.png`. Screenshots contain clearly labeled isolated sample stores (including locked non-direct, inactive and default-disabled new-store examples), not production business mutations.

### Changed implementation files

- `prisma/schema.prisma`, additive M67 SQL.
- `server/sweet-card-availability.js`, router registration in `server/app.js`.
- Permission-check boundaries/audit in `server/sweet-card.js` and historical recovery scope in `server/pos.js`.
- `src/components/SweetCardAvailability.jsx`, `SweetCardPage.jsx`, POS config refresh/Chinese reason in `PosPage.jsx`, shared `sweetCardLabels.js`.
- API acceptance, historical rollout assertion, initialization, verification, monitor and deployment scripts; isolated UI harness and this report.
