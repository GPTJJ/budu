# budu 甜意卡 1.0 Business Contract

## Product boundary

`budu 甜意卡` is a controlled business-gifting consumption benefit for budu-operated stores. Version 1 supports physical and electronic cards, repeated redemption until exhausted, fixed validity choices of one year, three years, or long term, preset face values of CNY 500/1000, and a server-validated positive custom amount.

It is not publicly sold, rechargeable, transferable, splittable, mergeable, withdrawable, or cash-convertible. Issue is not sales revenue. Redemption is settlement of a real POS sale.

## Stable identity and value

- Value account owns initial value, ledger-derived balance projection, validity, status, binding policy, and eligibility policy.
- Credential owns physical/electronic carrier, public card number mapping, hashed high-entropy QR secret, activation, revocation, and replacement.
- Ledger events are immutable and include ISSUE, REDEEM, REFUND, and only justified reversal semantics. Normal administration cannot directly edit balance.
- Losing/replacing a card revokes the old credential and creates another credential for the same account. It does not debit and credit value between accounts.

## Status and lifecycle

Support explicit CREATED/UNACTIVATED, ACTIVE, FROZEN, LOST, EXHAUSTED, EXPIRED, and VOID/REVOKED semantics with server-controlled transitions. Physical credentials start unactivated. Electronic credentials may activate immediately or on issue. Only active, valid credentials can redeem.

## Store, product, and identity policies

- Reuse canonical `Store`; use a stable eligible-store policy if Store lacks ownership authority. Never hardcode current store names or keys in redemption logic.
- Products are eligible by default. Deny categories through a policy keyed by canonical `ProductCategory.id`; renames must not change the rule.
- The server derives eligible and ineligible subtotals from authoritative OrderItems and products. Freeze per-item eligibility and allocation at checkout.
- `recipientLabel`, recipient type/company/scenario/note are business metadata only. They never prove customer identity.
- Binding modes are NONE, OPTIONAL, REQUIRED. OPTIONAL may redeem unbound and later bind. REQUIRED cannot redeem unbound. Reuse an existing verified customer/member/WeChat identity authority; if none exists, provide an administrative binding and future self-bind hook rather than inventing SMS identity.

## POS settlement and refund

One Order may use at most one Sweet Card. It may combine with exactly the remaining canonical WeChat, Alipay, or Cash settlement. The server must enforce:

`Order.payableAmount = Sweet Card redemption + remaining successful Payment settlement`

Sweet Card QR tokens use an explicit namespace and are routed before provider barcodes so they can never be submitted to WeChat or Alipay. All amounts are integer cents.

Refunds keep canonical Refund authority. Deterministic refund allocation uses checkout-time item/tender snapshots. Sweet Card-funded value returns only to the original value account; external/cash-funded value follows its own existing refund contract. Repeated requests cannot restore value twice, and aggregate refunds cannot exceed original allocations.

## Security, audit, presentation, and permissions

- Prevent token enumeration/leakage/replay, double spend, repeated refund, unauthorized issue/activation/redemption, negative balance, invalid-state redemption, blacklist bypass, ineligible-store use, and binding impersonation.
- Audit create/batch create, QR export, activate, issue, bind, lost/freeze/unfreeze, replace, void, redeem, and refund restore with actor/time/entity and safe before/after metadata. Never include raw QR secrets.
- Management uses dedicated VIEW/ISSUE/MANAGE/ACTIVATE/FREEZE/VOID/AUDIT capability semantics. POS redemption uses canonical `store-pos` capability plus store eligibility.
- Physical-card export maps public card number to print-quality QR without a public URL. Electronic-card data follows a replaceable presentation contract using the canonical budu logo, title, companion line, value, expiry, QR, card number, and optional recipient/message.
- Production feature enablement defaults OFF and requires a separate production authorization.
