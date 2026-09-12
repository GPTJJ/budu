# Sweet Card 1.1B — backend settlement candidate

Status: SWEET_CARD_1_1B_BACKEND_SETTLEMENT_READY (isolated scope).
Reviewed2026-09-12. This is NOT full1.1B completion or Production readiness.
No Production runtime/config/data mutation, no real payment and no upload.

## Git scope

OS branch codex/sweet-card-1-1b, priorHEAD3221c489c08cf8a641c4f264ec394d29d14d0de1.
Companion MP candidate77c91456030d961a0df1f636ea1122d9c50ca607, same branch.
MP includes9267d7c catalogue adapter and corrected41c7050 released-client baseline.
Unknown OS files preserved/excluded: native-environment checkpoint and local
native-test-environment shell script. No unrelated checkout was reset/stashed.

## Delivered chain

CloudBase catalogue → authenticated server quote → immutable commerce draft/link
→ PG settlement/reservation/tenders → JSAPI remainder → verified provider evidence
→ exactly-once capture/PAID → durable outbox → authenticated commerce mirror.

- Quote includes userId, quoteId/version/expiry, immutable purchased items,
  merchandise/eligible/freight, available/requested/actualSC, WX and total cents.
- Client money/identity assertions cannot replace server facts. Gateway HMAC
  includes sessionHash; actual runtime WeChat identity must match PG customer.
- Quote/draft expiry at most15min, bounded additionally by card/catalog expiry.
  Changed selection with same quote key denies. Different submit key cannot
  create a second commerce order for the same frozen quote.
- OneSC/order. Available ledger minus reservations under existing account lock.
- SC-only captures and PAID atomically, no fake WX tender/payment.
- Mixed reserves only, shippingWX-only, signed JSAPI uses frozen payer/remainder.
- Raw signed/decrypted provider callback or verified query is required to capture.
  Client success has no settlement endpoint. Duplicate callback is idempotent.
- Cancellation/expiry/restart recovery preserves unknown provider outcomes.
- CloudBase failure/lost ACK cannot undo confirmed financial truth. Native leased
  outbox retries and fences acknowledgements; receiver deduplicates versions.
- Canonical combo labels, flavor selections and spec survive into order items.
- Customer order reads project PG financial status and cents; new query is gated
  by runtime flag, preserving legacy reads when1.1B is absent.

## Runtime composition (candidate only)

OS loadOnlineCheckoutConfig returns null by default. Explicit
SWEET_CARD_ONLINE_RUNTIME_ENABLED=1 is required to mount/start. Runtime remains
ON while obligations exist, independently of SWEET_CARD_ONLINE_PAYMENT_ENABLED.
Purchase flag OFF keeps callback, query, cancel and background recovery working.

Mount before general JSON parsing:
- POST /api/online-checkout/wechat/notify (raw signed body≤1MiB)
- POST /api/v2/customer/online-checkout/{quote,plan-order,submit,prepare,cancel,status}
  (signed gateway plus customer session, JSON≤256KiB).

Configured payment files require root-owned0400/0440 files. Production gateway
binding uses existing approved environment/AppID/DB checks. New payment fields:
SWEET_CARD_ONLINE_WECHAT_MCH_ID, PLATFORM_KEY_ID, MERCHANT_SERIAL, NOTIFY_URL;
file fields under the same prefix: PLATFORM_PUBLIC_KEY_FILE, API_V3_KEY_FILE,
PRIVATE_KEY_FILE. Mirror fields: SWEET_CARD_ONLINE_MIRROR_KEY_ID, MIRROR_URL,
MIRROR_PRIVATE_KEY_FILE. Full names use SWEET_CARD_ONLINE_ prefix.
Never dump returned config. No keys were provisioned or changed by this work.

CloudBase orders uses its runtime switch plus existing
SWEET_CARD_PRODUCTION_GATEWAY_SECRET server setting. Fixed HTTPS destination,
8s absolute deadline,256KiB bounded requests/responses, no redirects/retries.
Mirror index.main has actual-runtime scope checks and independent RSA public-key
verification. Required private collections/indexes and deployed HTTP mapping
remain separate release prerequisites; no auto-provisioning occurred.

## Current direct verification

OS140/140 PASS:
SC11B_MP_REPO=<companion> SC11B_NATIVE_CONFIG=<private isolated config>
SC11B_NATIVE_PG_MODULE=<isolated pg module>
node --test --test-concurrency=1 scripts/test-online-*.mjs

This includes native PostgreSQL16.14 constraint/concurrency/capture/recovery
suites and7 cross-repository checkout HTTP E2Es. OS suites also include offline
policy/transport tests;140 must not be labelled140 native database cases.

E2E uses real local PG, Express runtime.mount, loopback signed customer/notify
HTTP and real native outbox lease/retry/ACK. Provider RSA/AES messages are
synthetic. CloudBase database uses transactional in-memory adapter; mirror HTTP
request is passed to actual HTTP-event handler through injected fetch, not live
CloudBase or a mirror socket. This boundary remains explicit.

Companion MP192/192 PASS including released3.5.1 startup/input/Claim/POS,
legacy payment/refund and all new bridge/transport/read/mirror contracts.
Independent closeout focused22/22 PASS; reviewer found no remaining blocker to
isolated backend settlement milestone. OS build and local MP Production bundle
PASS. No upload or deployment.

Reconciliation: per-fixture account balance equals SUM(ledger); total equalsSC+WX;
reservation/capture idempotency verified. Financial reconciliation delta=0.
Synthetic fixture ISSUE/CAPTURE are expected isolated facts, not zero mutation.
Production mutation=NONE; no new migration added by this integration. Previously
prepared additive migration exists only in candidate/native71-migration DB.
Production70/0 baseline is historical evidence, not freshly revalidated here.

## Continue Master Plan

Customer checkout UI, online merchant fulfillment approval/ship transitions,
source-correct full/partial refunds, verified refund/compensation executor and
recovery, native POS-vs-online concurrency certification, fresh clone rehearsal,
real CloudBase SDK/index/ACL and WeChat callback/console/human E2E remain.
Production deployed Gate0.6 payment remediation remains UNVERIFIED; local candidate
coverage is not evidence of live activation. Do not deploy under current directive.

Refund next-step audit: reuse account lock and existing Ledger semantics, NOT
legacy POS completeSweetCardRefund (different FK authority). OnlineRefund schema
already provides immutable cumulative allocations and native constraints. Define
explicit online merchant approval/store scope before exposing approval routes.
Customer request is nonfinancial; approved intent becomes PENDING until verified
WX refund success, then exactly-once original-accountSC credit. Shipping returns
WX-only. Late-payment compensation is WX-only and must never creditSC.
