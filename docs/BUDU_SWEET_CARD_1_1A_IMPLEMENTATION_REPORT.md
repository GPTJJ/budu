# budu Sweet Card 1.1A — Implementation Report

Date: 2026-09-06 (Asia/Shanghai)  
Overall: `SWEET_CARD_1_1A_READY_FOR_MANUAL_RELEASE_GATE`

## Release boundary

- OS implementation baseline: `cc5dcf12fcbc9ae9552921d0fa917898a8403998` on `codex/sweet-card-1-1a`.
- MiniProgram post-A9 source candidate: `4c2ba50408bea6ea5e43bf54727f313ca0f85d4c` on `codex/sc11-a06-environment-isolation`; documentation head `302895a7ae5b6eeec3a61b11fbe03c8330f08e97`.
- Production runtime: `3838b35b6e2a`, healthy, restart count 0.
- Production database: `budu_bj006`; Migration 67 applied / 0 failed; exactly one running container uses the canonical Production `DATABASE_URL`.
- Production Sweet Card balance and Ledger: 500,090 / 500,090 cents; delta 0.
- Production MiniProgram Claim feature flag: `OFF` because `SWEET_CARD_MINIPROGRAM_CLAIM_ENABLED` is absent from the current Production runtime.
- Production deploy, migration, Claim, Binding, review, and release in A8/A9: NO. A Test-only development version was uploaded and manually designated as the experience version.
- Sweet Card 1.1B: NOT STARTED.

## A1–A7 preserved result

A1–A7 remain PASS at the accepted baselines. The canonical authorities are the server-observed WeChat identity mapping to stable `User.id`, server sessions, separate Claim credentials, `SweetCardClaim`, and the existing `SweetCardBinding`. Claim and Binding do not activate cards or change balance, Ledger, Redemption, Refund, Payment, or Order facts.

Test PostgreSQL `budu_sc11a_test` contains additive Migrations 68–70 for the identity bridge, customer session, Claim credential, Claim receipt, and User binding. Production remains at Migration 67; the Test migration state is not treated as Production approval.

Physical and electronic carriers share one economic authority. Claim QR and proof remain separate from the POS credential. Store Availability remains dynamic. Security, replay, concurrency, wallet authorization, legacy Sweet Card 1.0, POS, payment-channel, Product, Payroll, and Transfer evidence is recorded in the A1–A7 checkpoints.

## A8 — privacy and platform preparation

Result: `A8_READY_PENDING_MANUAL_PLATFORM_STEP`.

Completed in the MiniProgram candidate:

- Added an in-app, versioned privacy and user-agreement page covering WeChat login identity, the stable internal account mapping, Sweet Card ownership and binding, recipient display text, wallet access, and current account/order/payment processing.
- The notice explicitly limits Sweet Card 1.1A to Claim, Binding, and wallet viewing. It does not claim Sweet Card online payment, online refund, nationwide ordering, or logistics.
- Removed raw OpenID display/copy from the ordinary customer page, removed OpenID from avatar object paths, and removed it from the candidate `user:get` response. The server retains OpenID only as internal authentication authority.
- Added a platform privacy and release checklist. Suggested version: `3.5.0`, subject to checking current platform version numbering. Suggested remark: `甜意卡领取与绑定、我的甜意卡、实体/电子卡支持`.
- Native WeChat Developer Tools compiled and rendered the privacy page. Evidence screenshot: `/Users/apple/.codex/outputs/sweet-card-a8-a9-20260906/a8-privacy-notice.png`.

Security review:

- MiniProgram source scan: 0 full Claim tokens, 0 Claim proofs, 0 POS credentials, 0 AppSecret-shaped values, and 0 `session_key` values.
- Current Test API source contains 0 exact matches for the mounted AppSecret value.
- Current Test API logs contain 0 full Claim tokens, Claim proofs, POS credentials, `session_key` values, or OpenID-shaped values.
- Result: `NO_SECRET_LEAK`.

Platform evidence:

- Current official MiniProgram version: `VERIFIED` from the WeChat Public Platform version-management screenshot.
- Online version: `3.2.7`; publisher: `Dh`; publish time: `2026-09-04 10:18:07`; remark: `首页 OUR STORY 品牌故事文案更新`; state: online.
- Review version: none pending.
- Test development version `3.5.0-a9-test`: submitted at `2026-09-06 20:29:53`, marked as the experience version, not submitted for review or released.
- Evidence: `/Users/apple/.codex/outputs/sweet-card-a8-a9-20260906/a8-official-version-baseline.png`, SHA-256 `ee90a1541e9391bceebecc5eabdd191a6dd304163ed643871188f718153c933f`.
- Current WeChat privacy guide and declaration remain `MANUAL_RELEASE_EVIDENCE_PENDING`.
- The permitted in-app browser rejected `mp.weixin.qq.com` under its site safety policy. No alternate browser surface or protocol workaround was used.

## A9 — real Test E2E

Result: `A9_PASS`.

Verified chain: Test experience version `3.5.0-a9-test` → Test CloudBase `budu-test-d8gwb4xwy41dc6c61` → Test `sweetCardApi` → Test API → `budu_sc11a_test`. Test remains at Migration 70 / 0 failed.

Real identity and Claim matrix:

- Two real WeChat identities resolved to different stable internal users. USER_A's 26 Test sessions continued to resolve through one WeChat identity; USER_B resolved through a separate identity.
- USER_A completed ACCEPTANCE_TEST Claim flows for NONE, OPTIONAL, and REQUIRED binding modes across physical and electronic carriers.
- Safe same-user replay, wallet authorization, balance/status/validity/recipient/binding/carrier/store detail, and a Test-side authoritative balance refresh from ¥50.00 to ¥48.75 all passed.
- The real same-card race produced USER_A 201 and USER_B 409. Repeated USER_B requests remained 409. The database contained one owner, one Claim and one Binding for the race card, with no ownership transfer.
- USER_B's wallet contained zero cards. USER_A's claimed card was not visible cross-user.
- The race Claim and Binding left the card balance and Ledger at 5,000 / 5,000 cents. The complete A9 fixture reconciled at 19,875 / 19,875 cents, delta 0 before cleanup.

A9 compatibility fix:

- WeChat's experience-version code can deliver launch options percent-encoded. The Claim page now uses one guarded decoder for token, proof and scene inputs, accepting raw or encoded options and failing closed on malformed encoding.
- The exact live E2E completed with raw launch options. The post-A9 compatibility fix is committed locally at `4c2ba50408bea6ea5e43bf54727f313ca0f85d4c`, passes 38/38 MiniProgram tests, and has not been uploaded.

Security and cleanup:

- One Test proof suffix pasted into the operator conversation was immediately revoked. Its replacement was consumed by the race. No Production secret was exposed.
- Exact Test cleanup removed one batch, four accounts, four Claims, two Bindings, five Ledger rows, three customer users, three WeChat identities and 28 customer sessions.
- Post-cleanup A9 fixture rows, Test WeChat identities and Test customer sessions are all zero. All local Claim/session temporary files and QR artifacts were destroyed; non-sensitive success/denial/wallet screenshots remain.
- Machine evidence: `docs/checkpoints/2026-09-06-sweet-card-1.1a-a9-real-e2e.json`.

## A10 — controlled Production rollout

Result: `NOT_STARTED_PREREQUISITES_INCOMPLETE`.

A10 did not start because current privacy-platform evidence remains incomplete. The official-version baseline is now VERIFIED. The real USER_A/USER_B matrix is now PASS. No Production candidate was deployed, no Production backup for A10 was created, and Migrations 68–70 were not applied to Production.

Before A10 may begin, the manual A8/A9 evidence must pass. A10 must then independently verify a fresh canonical backup, isolated Migration 68–70 rehearsal and schema diff, rollback assets, health, single writer, and full legacy regression. Any backend deployment must start with Claim OFF; any later Claim enablement must remain limited to an explicit test-customer allowlist. Full public rollout is not authorized.

## Regression and current reconciliation

- A8 MiniProgram environment, CloudBase, payment safety, API, Claim UI, privacy, responsive, and accessibility contracts: 55/55 PASS.
- Post-A9 launch-option compatibility regression: 38/38 PASS.
- Privacy JavaScript syntax and diff checks: PASS.
- A1–A7 accepted regression evidence remains PASS; A10 full Production regression is intentionally not claimed because A10 did not start.
- Production public/internal health and DB: PASS.
- Production runtime restart count: 0.
- Production single writer: PASS (1).
- Production accounts: 18; Ledger rows: 31; redemptions: 9; refunds: 4; payments: 166.
- Production Ledger / balance / delta: 500,090 / 500,090 / 0 cents.
- Production write during A8/A9 final-gate work: NO.

## Minimum manual steps

1. In 微信公众平台 → 用户隐私保护指引, capture the current effective declaration, update time, state and declared information types.
2. Do not submit for review or release until A10 prerequisites and the controlled Production rollout are separately authorized and verified.

Evidence images are stored under `/Users/apple/.codex/outputs/sweet-card-a8-a9-20260906`. They contain no full OpenID, AppSecret, `session_key`, Claim token, POS credential, or internal User ID.

Model configuration could not be independently verified: `MODEL_CONFIGURATION_NOT_VERIFIABLE`.
