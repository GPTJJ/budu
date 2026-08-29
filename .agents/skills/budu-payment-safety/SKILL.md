---
name: budu-payment-safety
description: MANDATORY for any BUDU task touching Payment, Refund, WeChat Pay, Alipay, payment providers, payment callbacks, payment or refund reconciliation, payment status, POS checkout, or payment secrets. Always classify such work as STRICT; do not use for unrelated POS display-only changes.
---

# BUDU Payment Safety

Treat PostgreSQL `Order`, `Payment`, `Refund`, and their canonical transition/log services as financial authority.

- The frontend cannot mark a payment successful.
- Network timeout is not payment failure.
- Keep ambiguous payments pending, query the original merchant trade number, and never blindly create another charge.
- One Order must not produce two effective successful Payments.
- A pending payment cannot switch channel until it reaches a safe terminal resolution.
- Callback handling must verify provider authenticity/signature, merchant/app identity, merchant trade number, provider trade identity, amount, currency when applicable, and allowed status. Fail closed.
- Successful refund totals must not exceed the refundable successful payment amount; concurrent refunds must remain safe.
- Secrets, private keys, certificates, and complete payment auth codes must never be logged, committed, or persisted in ordinary analytics.

Payment changes require provider idempotency, ambiguous-result recovery, crash recovery, reconciliation, accounting checks, and relevant POS coverage. Adding another provider requires zero business regression in existing WeChat payment behavior.

Real production payment/refund, provider enablement, secret activation, and cutover each require an explicit production gate and reviewer authorization. A candidate or merchant-configuration task does not grant them.
