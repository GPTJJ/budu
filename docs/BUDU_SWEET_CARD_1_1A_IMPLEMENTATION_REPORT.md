# budu Sweet Card 1.1A — Implementation Report

Date: 2026-09-06 (Asia/Shanghai)  
Overall: `SWEET_CARD_1_1A_READY_FOR_MANUAL_RELEASE_GATE`

## Release boundary

- OS implementation baseline: `cc5dcf12fcbc9ae9552921d0fa917898a8403998` on `codex/sweet-card-1-1a`.
- MiniProgram A8 candidate: `3129ad9d75ccfed29101ae1e400f692f701361af` on `codex/sc11-a06-environment-isolation`.
- Production runtime: `3838b35b6e2a`, healthy, restart count 0.
- Production database: `budu_bj006`; Migration 67 applied / 0 failed; exactly one running container uses the canonical Production `DATABASE_URL`.
- Production Sweet Card balance and Ledger: 500,090 / 500,090 cents; delta 0.
- Production MiniProgram Claim feature flag: `OFF` because `SWEET_CARD_MINIPROGRAM_CLAIM_ENABLED` is absent from the current Production runtime.
- Production deploy, migration, Claim, Binding, MiniProgram upload, review, and release in A8/A9: NO.
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

Manual platform evidence remains pending:

- Current official MiniProgram version, publish time, version remark, and state: `MANUAL_RELEASE_EVIDENCE_PENDING`.
- Current WeChat privacy guide and declaration: `MANUAL_RELEASE_EVIDENCE_PENDING`.
- A historical document records official version 3.2.5 published on 2026-09-01 16:39 CST, but this is STALE and is not accepted as current evidence.
- The permitted in-app browser rejected `mp.weixin.qq.com` under its site safety policy. No alternate browser surface or protocol workaround was used.

## A9 — real Test E2E

Result: `MANUAL_TWO_WECHAT_E2E_REQUIRED`.

Verified chain: Test MiniProgram → Test CloudBase `budu-test-d8gwb4xwy41dc6c61` → Test `sweetCardApi` → Test API → `budu_sc11a_test`. Test is at Migration 70 / 0 failed.

USER_A completed:

- Two real `wx.login` exchanges resolved to the same stable internal customer, with different server sessions.
- Claimed ACCEPTANCE_TEST cards for NONE, OPTIONAL, and REQUIRED binding modes.
- Verified physical and electronic Claim flows, safe same-user replay, wallet authorization, and detailed balance/status/validity/recipient/binding/carrier/store presentation.
- Verified a Test-only POS-side authoritative balance fixture change from 50.00 to 48.75 appeared after wallet refresh.

Current Test fixture state is deliberately retained because the two-user race is incomplete:

- One ACCEPTANCE_TEST batch, four accounts, three Claims, one Binding, and one unclaimed REQUIRED/PHYSICAL race card.
- Fixture balance and Ledger both equal 19,875 cents; delta 0.
- The preview QR carries only the Claim entry token. The independent proof remains a mode-0600 local temporary file and is displayed only in the system Terminal.

USER_B blocker:

- USER_B is listed as an experience member, but scanning a Developer Tools preview QR displays `暂无体验权限`.
- WeChat's official permission model gives experience members access to a platform-designated experience version, while development-version/Developer Tools access requires developer permission. Reissuing a preview QR cannot grant account permission.
- No USER_B `wx.login`, Claim resolve, Claim submit, or Test API mutation occurred.
- The exact Test Candidate must be uploaded as a development version and manually designated as the experience version before an experience-only USER_B can continue. It must not be submitted for review or released.

Still required for A9 PASS:

1. Prove USER_B repeated login resolves one stable internal user and differs from USER_A.
2. Run the real USER_A/USER_B same-card competition: one success only, one owner, one Binding, no duplicate Claim.
3. Verify losing-user replay and cross-user wallet/detail access are denied.
4. Capture non-sensitive evidence, remove the exact A9 Test fixtures, and destroy all local Claim/session temporary files.

## A10 — controlled Production rollout

Result: `NOT_STARTED_PREREQUISITES_INCOMPLETE`.

A10 did not start because current official-version/privacy evidence and the real USER_B matrix are still incomplete. No Production candidate was deployed, no Production backup for A10 was created, and Migrations 68–70 were not applied to Production.

Before A10 may begin, the manual A8/A9 evidence must pass. A10 must then independently verify a fresh canonical backup, isolated Migration 68–70 rehearsal and schema diff, rollback assets, health, single writer, and full legacy regression. Any backend deployment must start with Claim OFF; any later Claim enablement must remain limited to an explicit test-customer allowlist. Full public rollout is not authorized.

## Regression and current reconciliation

- A8 MiniProgram environment, CloudBase, payment safety, API, Claim UI, privacy, responsive, and accessibility contracts: 55/55 PASS.
- Privacy JavaScript syntax and diff checks: PASS.
- A1–A7 accepted regression evidence remains PASS; A10 full Production regression is intentionally not claimed because A10 did not start.
- Production public/internal health and DB: PASS.
- Production runtime restart count: 0.
- Production single writer: PASS (1).
- Production accounts: 18; Ledger rows: 31; redemptions: 9; refunds: 4; payments: 166.
- Production Ledger / balance / delta: 500,090 / 500,090 / 0 cents.
- Production write during A8/A9 final-gate work: NO.

## Minimum manual steps

1. Explicitly authorize uploading the exact Test Candidate as a development version for A9 only.
2. In 微信公众平台 → 版本管理, manually select that uploaded development version as the experience version. Do not submit it for review or release it.
3. USER_B opens the experience version, follows the retained race Claim entry, enters the independent proof already shown in Terminal, and stops before tapping the Claim button.
4. Resume the controlled race while USER_A remains at the same card's ready state.
5. In 微信公众平台, capture the current official-version details and current 用户隐私保护指引, then reconcile them against the prepared checklist.

Evidence images are stored under `/Users/apple/.codex/outputs/sweet-card-a8-a9-20260906`. They contain no full OpenID, AppSecret, `session_key`, Claim token, POS credential, or internal User ID.

Model configuration could not be independently verified: `MODEL_CONFIGURATION_NOT_VERIFIABLE`.
