# Daily Performance Correction — isolated candidate checkpoint

Date: 2026-09-16 (Asia/Shanghai).
Status: VERIFIED isolated implementation / acceptance; not a production release.

## Authority and Git

- User-approved baseline: `f18e903f721567d4d35c0d19d0a99cd268edf045`.
- Branch: `codex/daily-performance-correction`.
- Worktree: `/Users/apple/Desktop/budu-daily-performance-correction`.
- Remote: https://github.com/GPTJJ/budu.git
- At implementation acceptance HEAD remained the baseline with uncommitted changes. The subsequent user-authorized preservation commit includes this checkpoint; see the [Reviewer handoff](2026-09-16-daily-performance-correction-reviewer-handoff.md). No mainline integration is authorized.
- Remote authoritative branch was directly checked with ls-remote and remains `520760eeb8f4bdb8dd71a0853f59c070d70b659d`.
- Common ancestor: `9a8e48727069aeac46f0938f37a115eec21a57be`.
- VERIFIED divergence: mainline-only 1; production-only 92. Neither tip is ancestor of the other.
- Mainline-only: `520760e docs(handoff): record payroll snapshot hotfix`; documentation only.
- The actual payroll snapshot runtime fix `9a8e487` is in both histories.
- No authoritative movement, merge, rebase, deployment, production DB mutation, or production migration occurred.
- Prior runtime observation / user-approved production is f18e903; stale authority-container/current-sha files are not used. This candidate report does not re-certify live DB health/ledger.
- Existing unknown changes in the original worktree were preserved and excluded.

## Divergence risk audit

Production-only history includes Sweet Card, Alipay and checkout runtime, report settlement projections, catalog guards, and payroll frontend refresh fixes (b8c27e8 / a3e8c1c / 01faa20). They remain intact through the exact production baseline ancestry.
DailyEntry correction implementation and payroll formula files have no baseline-to-mainline diff. Relevant changes are:
```
server/report-center-query.js | 43 +++++++++++++++++++++-----------
 shared/accountPermissions.js  | 57 +++++++++++++++++++++++++++++++++++++++++++
 2 files changed, 86 insertions(+), 14 deletions(-)
```
Report query differences are Sweet Card/MIXED settlement composition; capability differences are Sweet Card capabilities. This patch does not replace those files with mainline versions.
Future merge risk: the histories are divergent. Do not reset/overwrite Production with mainline or cherry-pick an old full file. Integration must retain f18e903 ancestry and re-audit a then-current runtime/mainline. Divergence audit PASS means the isolation and risks are understood, not approval to merge or deploy.

## Existing authority reused

- DailyEntry is the current effective sales fact, with existing version.
- Existing DailyEntryAuditLog / daily_entry_audit_logs retains beforeValue, afterValue, reason, operatorId/operatorName, createdAt.
- Existing POST /v2/daily-entry/revise, transaction/advisory lock and optimistic version guard are reused.
- Existing ledger API derives revised status from audit; UI label is now 已更正.
- No parallel Correction model/table/API or duplicated current business authority.
- Latest effective values update the original entry in the same transaction as audit insertion. Before values remain in the existing audit.
- Original display uses earliest retained revision before snapshot. Missing legacy original snapshots are explicitly unavailable, never inferred.

## Scoped implementation

- Confirmed manual history detail exposes 更正数据 for Developer / existing admin role (Super Admin equivalent), additionally requiring existing REVISE capability and server store scope.
- Ordinary staff, manager and finance cannot revise historical facts; hybrid adjust entry also applies this role gate, preventing an alternate privilege path. Existing unconfirm route already rejects reverting confirmed rows.
- Sales-only intent never submits/replaces attendance. Legacy payable-hours facts remain intact.
- Mandatory reason; original/current/new display; second confirmation.
- Existing audit primary key deterministically identifies actor + requestKey. Canonical normalized command digest binds replay to store/date/version/values/reason.
- Same-key retry returns success without extra write; changed payload with same key rejects. Different simultaneous commands on same version yield one success / one stale conflict.
- Audit failure rolls back entry change.
- Current POS/hybrid or historical POS/conflicting source evidence fails closed; no manual override of Order sales authority.
- After success ledger reload and shared user-data refresh use existing refresh paths. Failed refresh is reported as saved-but-refresh-failed.
- No schema/migration or production changes.

## Real downstream dependencies

1. Ledger and /v2/daily-entries read current DailyEntry directly.
2. ReportQueryService.resolveScope/summary reads confirmed manual DailyEntry and aggregates daily/weekly/monthly ranges and store summaries; existing POS/manual selection remains unchanged.
3. Legacy finance computeProfit reads DailyEntry on request (compatibility only; not promoted to new profit authority).
4. Payroll loadAuthoritativePayrollRange reads DailyEntry revenue/order count and existing attendance, invoking the unchanged payroll resolver. Real commission dependencies recompute on next read; no persisted payroll notice, adjustment, bonus, or formula is rewritten.
5. Shared frontend loadUserData refresh invalidates existing projections. Previously exported/sent reports are not rewritten or resent.
6. Order, Payment, inventory, Transfer and attendance have no mutation from this sales-only command.

## Acceptance evidence

- Full existing DailyEntry B–F API regression plus new sales correction tests: PASS in isolated PostgreSQL.
- Existing production migrations applied unchanged to isolated database public schema: PASS. No new migration.
- Old random-schema test initializer failed on pre-existing migrations with explicit public schema references. Recorded as harness incompatibility, not silently changed migration. Test-only mode validates localhost:15487 / budu_correction_test before using disposable public schema.
- New checks: staff DENY; admin PASS; finance/manager DENY; mandatory reason; reject attendance payload; idempotency; changed request replay rejected; concurrent stale conflict; duplicate parallel retry; before/after audit; ledger revised; report reads corrected revenue; audit failure rollback.
- Reconciliation: DailyStoreStaff, Employee, Schedule, PayrollNotice unchanged across sales corrections; existing legacy historical preservation tests PASS.
- Payroll actual commission responds to corrected revenue, payableHours unchanged; payroll formulas untouched.
- Pure regression: daily-entry-v2-payroll, payroll-orphan-dependency, report-center-rc3-source: 9 tests PASS.
- Build: PASS.
- WebKit UI: 320/340/375/390/430/1280 no horizontal overflow; original/current/new display; reason required; second confirmation; cancel no writes; 500 retry preserves requestKey.
- Full StoreEntryPage history → detail → correction entry verified in isolated browser harness.
- Stale 409 disables repeat submission; nested overlay retains global scroll lock until the last overlay closes: PASS.
- Artifacts: output/playwright/correction-390.png and correction-history-390.png (local only).
- No production data used in fixtures and no production business notifications sent.

## Handoff

At initial acceptance the implementation was uncommitted and not remotely recoverable. The user subsequently authorized one candidate commit and independent-branch push. The preservation commit and remote verification supersede that initial Git state; see the Reviewer handoff. Test artifacts/tool output are not release files. Original worktree unknown files remain untouched.

The task-owned isolated PostgreSQL container and local tunnel/dev server were cleaned up after testing. Disposable fixture data was removed; production database/container were not changed.

Review this candidate before any release. Deployment is explicitly not authorized by this task.

## Production-only commits (complete ancestry list)

```text
f18e903f721567d4d35c0d19d0a99cd268edf045 fix(checkout): reject missing authoritative catalog policies
01faa200d1dbe0d413044205faf7e3bb85b3caf3 fix(personnel): reproject payroll on completed authoritative bootstrap
a3e8c1c2715625397bcfc0de860430a0d18c3414 fix(personnel): atomically retain authoritative payroll data during refresh
a91cb6d7db7074f77af7e91090f99f58ebdabebf test: certify latest production clone and controlled 1.1B candidate
3c66ebf4a6dfe6937b61ab469c26d7e45da65298 feat: certify online payment refund and fulfillment integration
86a23e7bf05aa4e143c2ba2b1f87e77ced36f523 feat: integrate authoritative checkout settlement runtime
3221c489c08cf8a641c4f264ec394d29d14d0de1 feat: preserve commerce selections in online checkout quotes
ed26985b12b5d25d5c99dc549da38153b3e4de58 test: cover cross-repo mirror HTTP acknowledgement recovery
9900178d38e3ca59fbcfaa8eed13658ba745450e feat(orders): deliver signed financial mirror events over bounded HTTPS
055e9fd60c27ac3522089c0334c87b25d35d7442 feat(orders): sign financial mirror events with scoped server identity
d4ed36c2298399bd8bb496b71b885903416203c1 feat(payments): add bounded background payment recovery scanner
e5fbb117cab4be436344b4dc22d99e45b3dc68b3 feat(payments): coordinate verified JSAPI prepay with cancellation
3651ef4426877d2c07f5474e630b0988c8d57334 feat(checkout): verify payment evidence and serialize capture with cancellation
19f3b255be0b46aba5063c48895163316db50430 feat(checkout): add server quote reservation and atomic card-only settlement
deff7110ae1ea4e7ed750be017987068dab1b012 feat(checkout): persist atomic financial snapshots and retryable mirror delivery
717f9de4ea1bfa9725380d771658e6f472d2e362 feat(checkout): add guarded financial schema and reservation-aware POS balance
bb6773d0fa18b96f004ed43d32dececd260c0713 feat(checkout): define online tender and cumulative refund policy
95cd9ce48b25de35570cc6f1f07154ab2e13cb78 fix(sweet-card): deliver PNG and local admin proof package
9f6da26b2efa2c08eb7c24cfb4eb27fc3e9b4f47 fix(sweet-card): generate official MiniProgram claim codes
7b571a53de02105d164503518f29b33ad68af5fd fix(sweet-card): support commercial claim eligibility
3d9ae49b5601fbec76d63db2a5fe5d3de3f0b576 feat(sweet-card): present existing POS redemption QR
c7e95a4efa4b22e91606a89cc9a0e46e9b3be725 fix(sweet-card): surface electronic asset eligibility
5b19c2ba040b61bd222b70cc06f5eeb3b0f09917 fix(sweet-card): enable controlled production delivery
7b81044483665726c00098a0ce1d11df41a8a0ba test(sweet-card): cover signed production claim gate
fba27936bc4aa8bc6a781479b1ed7025d80f5f27 feat(sweet-card): add signed production identity gateway
859790a655eb8889fe642cabb635e33f085749eb fix(deploy): separate Sweet Card A10 migrations from startup
ccaa280a72d1e30cd17a9f38a1bb42d7e9c0a74c Merge commit '6d9e4f8658e3329738dbec7a38d34a04cabaa4ed' into codex/sweet-card-1.1a-a10
b8c27e817f8d762903957cc0b5c30fe684d9867d fix(payroll): preserve detail data during refresh
6d9e4f8658e3329738dbec7a38d34a04cabaa4ed docs: record Sweet Card A7.5 readiness
c01431fb8ac47443379e8cecec863b7150aaa1b2 test: verify electronic card download
d282c19cc5513a37706399eeda9cfbde143e73f6 feat: add electronic Sweet Card delivery workflow
fc25c47cf202584e39cacef8367937aa4a2bc532 docs: record pending privacy review
04b4e317175ab78171e75518c2563fc39e1e43bf docs: verify updated privacy declaration
f54f36b55bc930f568ac65bd05c1eacec6d1dda0 docs: verify Sweet Card privacy evidence
29888272c71c0a9edf359e503f4d61b038e8669d docs: verify current MiniProgram official version
fccd5cb080636f72445d350104eae62a33705850 docs: close Sweet Card A9 real E2E gate
179f77e9b8162b33051fb2c9fbd0b49da2967997 docs: record A9 test development upload
f64d834afada0f3e97ecf1c49304a08df8e6a0f9 docs: correct A9 preview permission blocker
5578004c77118313b3c4a6f380d79d76c3b92f56 docs: record Sweet Card 1.1A manual release gate
cc5dcf12fcbc9ae9552921d0fa917898a8403998 docs: record Sweet Card A6 A7 readiness
cd4314f31b75086c332b52c228865ec963dde67a test(sweet-card): align physical claim channel assertion
bd2bd16a1c702744dcce14bddc1d0b2a24efab72 test(sweet-card): keep carrier matrix credential-free
a112587d5d02559dd8f2e4ddd3381d7371424d9d test(sweet-card): cover carrier and replay matrix
69eea74816aed16d7517da72948ea59b2e3f3385 fix(runtime): package canonical Sweet Card brand asset
b90758f20cfbd39b90890d1728501e0f8c976d45 feat(sweet-card): separate carrier claim assets and harden replay
04dd3b62e56a137ea044f3b23d7c7ff1e0ad46c6 docs: record Sweet Card A4 A5 readiness
e59615a087f93b46f315ebaea76cea22535db049 test(sweet-card): correct A4 A5 account fixture reference
7d624d22a5fa524823b9db496cd600ff0f5762b8 fix(sweet-card): allow default wallet store authority
390e3cfca941bc1c14530689c537bc8856cd965f feat(sweet-card): add customer wallet experience API
780417f8ded30584211c3931db8f1566825c2a53 docs: record Sweet Card A3 readiness
abb5ee578f2f5cd9d98399365e2c319dab58eb1f test(sweet-card): cover A3 HTTP and token expiry
828dbec48e195db8457798311cf9ad41ed92d578 feat(sweet-card): add atomic customer claim binding service
ceaa5079d9f339bdc9b0697b3d0005b9e32c2883 docs: record signed session evidence
150683db05283655482beee15cf5103c488a1432 fix(test): sign customer sessions
b9c89bc960e60031e4f4bf6211d226b25783d652 docs: record Sweet Card A1 A2 readiness
cb5c28961327d51cad4a34bad333087773721956 test(test): cover Sweet Card A2 HTTP contract
957e040a477ef818300cbf8ab7a72c7d274f98a0 feat(test): add Sweet Card A1 A2 foundations
7d44c3f2591540a90cd845d1e52b0bc2f0f54f97 fix(test): validate authority before migrations
af70684d137da937aaabca4f5bc7367d17b19456 feat(test): add isolated WeChat login harness
2f7d708bca1beb62cf20c91a9c1313be770aa440 feat(test): add isolated database authority probe
3838b35b6e2abd2196a8183901462329d610636b fix(deploy): preserve database network for store initialization
5c1ac6bd4634d4943cca9cd0b57f8ca79e53d3bd fix(deploy): select release bundle branch and guard early rollback
77950bb744a3aafd10e7b29a82254cf0e725e71b feat(sweet-card): store availability with inherited POS permission
d9dec2db747bc62cd8900c08ad68bd7b73b89254 docs(sweet-card): record production data organization gate
1d0899ac3b576f5a8045e49a929b4cf3939add35 fix(release): persist current SHA through root helper
9c734963918d84e1ded8da0eeca054c61831073e fix(release): run diff check outside test container
efdbde242f1ba28391d4d2ca6d4fc01bf6bda1fe test(payments): keep deadline transport double alive
dec11270128c113447f11c2e9d9db9f5b03400e1 test(sweet-card): serialize provider release checks
a99eecce3d1bfe6a7236260c186e7ccc5ad212a5 test(sweet-card): rehearse archive migration from canonical backup
a05633e9ac921a408b4464ce7bc12ef032ec162d ops(sweet-card): add guarded data organization release
fa0395c3806df10dbd0fc0c408bf3059767d5a85 docs(sweet-card): record data organization candidate
dcc2608f963c4fc80d4acb593a4b71e0c3ccb2af feat(sweet-card): add operational archive views
9432c16d2d353c2f7e69f9e2e41bc4bd513602a9 feat(sweet-card): localize management enum labels
a69690fd854969374bee7ed5939519572df32b05 docs(sweet-card): record xidan commercial go-live
fdd26ae3daada0a6b88616c74b65732c18743d7d docs(sweet-card): record commercial R1 readiness
fe4a7254a0ec9a68390cefe12b0766b3ec15ef93 feat(sweet-card): add typed batch purpose authority
5cb6791b476554388f812443157223c95f9776ef docs(sweet-card): clarify post-P19 backup scope
3a3dfd531e4f00fa4ffddc98c7eb21dfd1b34518 docs(sweet-card): record commercial release hold
43a059bcf8eff0bc3ec553733e05fb676075aee7 feat(sweet-card): gate xidan commercial POS access
d0d1bad079a3b42b5032d4f2b49aca6a2a39a870 docs(sweet-card): record P10C production completion
02f3f8fb6431157378c583802075713dd8bde8ef fix(sweet-card): retry serializable redemption conflicts
d2e0978f21fc61f085d885230817e0c3bbf655b4 docs(sweet-card): record P7C release and P10 conflict hold
cd5551352420b18e2347294604b51b28b4b92dda fix(sweet-card): serialize all redemption response amounts
00d7a77235de2a3f29f8bffbd49116f5e382b2fb fix(sweet-card): make settlement guards rail-aware
48c28fb1bfa9d1109c2a4562b916d0d1abc92e32 fix(sweet-card): enforce full rollout gate on mixed orders
644fb976206701b59aa89139e4f9395813b1a39b feat(sweet-card): add production test allowlist
12c93379409d944c37e1ab9708ea972fb4be1474 docs(handoff): record sweet card candidate
adfda23a622b6ccce39cbc798c27aaa0ca5c1569 feat(sweet-card): build candidate value account flow
ccdf1358938e53da99daf2a24d2cf3c6b13c8fed fix(payments): authorize POS channels by capability
c1e4e205a99be28654c920d7d21e191bae7dead9 fix(payments): use SDK-generated Alipay request IDs
041f964ae31e042c9673d1472039cb3f5926022a fix(payments): load Alipay PKCS8 key correctly
b15fa645b92191db0eb9e15e598925179395e2fe feat(payments): integrate Alipay on latest production baseline
```
