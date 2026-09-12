# Sweet Card 1.1B — controlled Production Candidate

Date: 2026-09-13. Scope: candidate certification only. No Production deployment,
configuration change, business write, MiniProgram upload/review/release or real payment.

## Latest-production integration authority

VERIFIED: routed live OS `95cd9ce48b25de35570cc6f1f07154ab2e13cb78`, image
`budu-api:delivery-95cd9ce`, pinned image SHA256
`0c04d3e814db0b0f7d92dd0c3a2f83281469533e14370ff67f913189f9741b46`.
Public/internal health PASS. Database `budu_bj006`, PostgreSQL16.14, migrations70/0.
Exactly one running Docker application connected to this Production database;
this count does not claim to inventory every possible external database client.
Nginx route, runtime environment SHA and health agree. `/opt/budu/current-sha`
is absent, so it was not used as authority.

Live OS is an ancestor of accepted application candidate `3c66ebf4a6dfe6937b61ab469c26d7e45da65298`.
No cherry-pick of stale base or unrelated feature branch was needed. Integration
branch in both repos: `codex/sweet-card-1-1b-production-candidate`.
Subsequent OS changes are test/evidence-only. Companion MiniProgram candidate
`8551906` extends accepted `fcc589e` with candidate-only disclosure alignment.

Fresh CloudBase CLI metadata and downloaded root source/config parity confirmed
orders/payOrder/merchant/sweetCardApi ACTIVE, Nodejs16.13, index.main.
No intervening drift in inspected root source/config from reviewed G05; whole-package
CodeSha256 was not supplied by the platform and is not claimed verified. Candidate preserves existing refund-signing
hotfix and excludes financial-domain orders from legacy authority. Private
production config.js files are intentionally absent from Git: future packaging
must securely preserve them and validate their contract, never commit their values.
Current MiniProgram platform release is UNVERIFIED in this audit; last human
screenshot showed3.5.1. No console-policy bypass was attempted.

## Native certification and monetary reconciliation

Fresh exact application suite183/183 PASS on local native PostgreSQL16.14,
including reservation concurrency, actual POS versus reservation, signed
synthetic provider callback/query, duplicate settlement/refund, shipping tender,
refund/fulfillment races and outbox recovery. Companion suite235/235 PASS.
Prior protected financial/provider unit suite197/197 PASS remains applicable:
protected application files were unchanged in this continuation.
All new financial amounts use integer cents and per-account/tender reconciliation.

Native synthetic fixtures reconcile with mismatch0 and monetary delta0. Deliberate
pending/failed/expired scenarios remain in the fixture database: operationallyClear
is false. This is not a drained Production obligation ledger and is not used to
approve a live rollback. Fresh production balance and signed Ledger aggregate both
1,300,110 cents before/after this task, delta0.

## Production-compatible clone and additive rehearsal

Fresh consistent custom pg_dump:43,145,158 bytes; SHA256
`1e98db29649f575167d767a880b50cfbc168f810c7fdd0c552d8e6638dd51e28`.
Protected remote backup directory:
`/opt/budu/.rollback-assets/sc11b-g9-20260913-3c66ebf` (0700; dump0600).
Raw history was neither printed nor committed. Restore verified by pg_restore
exit-on-error into distinct `budu_sc11b_g9`, internal Docker network, no published
ports, same pinned production PostgreSQL image. No production credentials/providers
were installed in the application smoke containers.

Exact candidate migrations71–73 applied successfully,73/0failed. Migration plus
post-migration hashing took11.2seconds; this is not a pure DDL timing measurement.
Runner used bounded lock/statement timeouts. All95 existing public tables excluding
Prisma migration metadata retained identical row counts and sorted row-content
hashes, both after migration and after runtime smoke. This covers historical Orders,
Payments, Refunds, SweetCard, Ledger, POS, Payroll, Partner and other existing tables.

Matching old Prisma/runtime95cd9ce and candidate-generated Prisma/runtime each
passed11 authenticated read endpoints against migrated clone (22/22 HTTP200),
including POS, payroll notices, employees, daily entries, transfer, partner orders,
SweetCard list and reconciliation. Database connections enforced read-only mode.
Both reported healthy and online runtime/payment OFF. First SweetCard reads were
503 because isolated capability defaulted OFF; enabling legacy SweetCard only in
isolated containers produced200. No Production flag was changed.

The candidate smoke image overlays exact candidate server/shared/utils/schema on
pinned production image and regenerates Prisma with network disabled. package.json,
package-lock.json and src are unchanged from live baseline, so base dependencies
and frontend assets remain applicable. This is an isolated compatibility image,
not a deployed final image. Temporary application and PG containers were stopped;
protected restore artifacts remain available.

## Rollback / forward-fix

See [conditional rollback review](2026-09-13-sc11b-rollback-review.md).
Before online facts exist, old runtime read compatibility with retained additive
schema is VERIFIED. No down migration or database restoration is an application
rollback. Once online obligations/history exist, keep candidate callback/query/
refund/recovery/outbox authority and turn purchase admission OFF. Do not route
back to old code that cannot serve these orders. Do not remove reservation or
Ledger constraints to force compatibility. Existing POS-versus-reservation tests
prove candidate serialization; no old-runtime real-money write was performed.

## Controlled deployment manifest / gates

Candidate default: SWEET_CARD_ONLINE_PAYMENT_ENABLED=0 and
SWEET_CARD_ONLINE_RUNTIME_ENABLED=0. Preserve existing1.1A PublicClaim configuration
(claim enabled1, allowlist-only0, gateway1); 1.1A Claim is distinct from online payment.
Future runtime enablement requires exact callback/query verification configuration,
merchant/customer gateway separation, commerce outbox receiver, fresh backup and
live authority revalidation. Do not drop old private configuration during packaging.

PRIVACY_1_1B_PURPOSE_UPDATE_REQUIRED=YES.
IN_APP_CANDIDATE_COPY_ALIGNED=YES (11/11 targeted checks).
Privacy platform confirmation remains MANUAL_WECHAT_CONSOLE_ACTION_REQUIRED at
review/release/public-enable boundary only. Real WeChat payment/refund and device
flows remain HUMAN_E2E_REQUIRED before public launch; synthetic signatures and
clone reads do not claim provider/console live acceptance. No upload or enablement
is authorized by this checkpoint. Candidate preparation is complete only with
the accompanying final Git/test report; full SWEET_CARD_1_1B_COMPLETE is not claimed.

Detailed safe evidence: [G9 evidence](2026-09-13-sc11b-g9-evidence.json).

## Final candidate closure

VERIFIED: full isolated critical runner PASS79/FAIL0, including environment
isolation self-check, after test-only obsolete fixture repairs. Fresh online
183/183 and MiniProgram235/235 PASS. Candidate preparation status:
PRODUCTION_CANDIDATE_READY. This does not mean deployed or public-payment ready.
Final exact Git commit identities are supplied by the delivery report; this
document does not manufacture a self-referential commit hash.
