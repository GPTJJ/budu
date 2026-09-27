# BUDU Alipay latest-baseline candidate checkpoint

Date: 2026-09-01 (Asia/Shanghai)

## Authority

- Production Git/runtime baseline: `9a8e48727069aeac46f0938f37a115eec21a57be` — VERIFIED before candidate creation.
- Production PostgreSQL: `budu_bj006`, 62 applied migrations — VERIFIED read-only before candidate creation.
- Candidate branch: `codex/alipay-latest-baseline-candidate`.
- Previous candidate `origin/codex/alipay-candidate@248607b83c74514376c29edd6aa56acdb24fad30` was used only as the semantic source; its unrelated safe-delete checkpoint commit was not imported.
- No Prisma schema or migration difference from the production baseline.

## Candidate scope

- Adds an Alipay OpenAPI V3/RSA2 provider for merchant-scans-customer barcode payment.
- Adds server-side create/query/cancel/refund/refund-query and verified form-urlencoded callback handling.
- Reuses canonical PostgreSQL `Order`, `Payment`, `Refund`, and `PaymentLog` authority and the current settlement authority contract.
- Extends the existing payment/refund reconcilers by provider without changing WeChat's protocol or configuration.
- Adds fail-closed configuration, store allowlist, POS feature gating, scanner validation, and isolated test coverage.
- Test runner strips every Alipay environment/key path so local or production payment credentials cannot leak into tests.

## Verification

- Alipay config/provider/callback/payment tests: PASS.
- Real disposable PostgreSQL Alipay idempotency and concurrent-refund guard: PASS.
- WeChat config/signature/provider/reconciliation/E2E regression: PASS.
- PaymentLog FK real PostgreSQL regression: PASS.
- Report Center RC-2A and RC-2C settlement-authority regression: PASS.
- POS core/order summary regression: PASS.
- POS iPad WebKit suite: 33/33 PASS, including 320/340/375/390/430 widths and Alipay pending/channel-lock behavior.
- Prisma validate: PASS.
- Vite production build: PASS.
- `npm audit`: 10 existing dependency findings (0 critical); none is attributed to `alipay-sdk` in the audit result. No dependency remediation is included in this candidate.

The broad `test:critical` run reached an existing date-sensitive Daily Fact Ledger suite on 2026-09-01. Tests with fixtures fixed to August 2026 timed out because the UI now defaults to September. The candidate has zero diff in that test and in the Daily Entry/Ledger business implementation; this unrelated stale test was not modified under the payment-only scope. `test-payment-log-fk-drift.mjs` also has an existing fixture mismatch with the latest production amount-authority trigger; the candidate has zero migration/schema diff and the real exact-FK regression passed.

## Merchant and secret readiness

- Alipay application `buduPOS`: online and face-to-face/barcode APIs visible in the merchant platform — VERIFIED in the signed-in merchant session.
- Local Git-external key directory: mode `0700`; contained key files: mode `0600`; RSA private key and distinct Alipay RSA public key parse successfully — VERIFIED without printing key material.
- No private key, certificate, production APPID value, or real auth code is committed.

## Production gate

- Production Alipay provider enabled: **NO**.
- Production secrets uploaded/activated: **NO**.
- Production deployment or nginx change: **NO**.
- Real payment/refund performed: **NO**.
- Gate 9 remains a separate reviewer-authorized production gate. It must start disabled, install read-only secrets, perform internal/unrouted smoke, enable one store only, then perform a separately authorized small real payment and refund with DB/provider reconciliation and a ready feature-flag rollback.
