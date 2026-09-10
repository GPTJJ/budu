# G3 verified payment and cancellation primitives

Candidate only. No production/runtime/configuration/business-data mutation.

## Implemented

- Isolated JSAPI v3 raw-byte RSA verification, bounded input, key identity,
  timestamp, AES-GCM notification decryption, app/merchant/amount/currency/type
  validation. Existing POS MICROPAY v2 remains unchanged.
- Notify/query share PG settlement/account locks and canonical WeChat identity
  lookup. Verified payment captures one reservation and existing REDEEM ledger,
  updates the balance projection and emits a PAID outbox snapshot atomically.
- Cancellation/expiry first commit CLOSING; NOTPAY and client intent retain holds.
  Only signed CLOSED query releases. SUCCESS uses the same finalizer.
- Released/invalid capture records verified WX tender plus durable compensation,
  no SC debit or fulfillment. Duplicate evidence does not duplicate compensation.
- Immutable quote cardValidity supports delayed in-validity payment even after
  expiry. Current freeze/loss/ownership restrictions still prevent capture.

## Evidence

Native PostgreSQL 16.14 synthetic database, loopback port 55461 listener verified.
17 payment/cancel tests; combined quote/outbox/payment suites 41/41 PASS.
Run shared-database suites with `--test-concurrency=1`: outbox worker tests drain
the synthetic global queue. Parallel test FILES interfere with that fixture;
internal concurrent callback/close/checkout tests remain concurrent.
Existing Sweet Card/availability/settlement and WeChat v2 provider/signatures:
74/74 PASS. Production build PASS. Independent reviewer checked validity fix
and cancellation state handling; no further proven issue in these primitives.

## Remaining integration (not PASS)

Authenticated routes, trusted catalog/commerce draft, prepay dispatch and close
transport coordination, HTTPS callback reachability, recovery scheduling,
provider compensation submission/confirmation and refunds remain required.
No deployment readiness or complete G3/G7 certification is claimed.
CloudBase receiver application service has 15 offline tests; signed transport,
private collection provisioning and live SDK concurrency are still pending.

Migration impact: none beyond existing candidate additive migration.
Rollback impact: do not run a hold-unaware runtime when reservations exist.
Original 1.1A flags unchanged; online purchase feature remains unexposed.
