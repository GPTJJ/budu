---
name: budu-sweet-card
description: Use automatically for BUDU requests about 甜意卡, 礼品卡, 商务赠卡, 甜意卡核销, 余额, 绑定, 挂失, 补发, 或相关 POS 混合支付/退款。Treat value, redemption, and refund changes as STRICT financial-authority work; do not use for unrelated generic membership or coupon features.
---

# budu Sweet Card

Use the formal user-visible name `budu 甜意卡` and the companion line `A LITTLE SWEETNESS.`. Read [business contract](references/business-contract.md) before designing or changing Sweet Card behavior.

## Required composition

- Use `budu-data-authority`: PostgreSQL is canonical; reuse `Store.key`, `InventoryItem.id`, `ProductCategory.id`, `Order.id`, and current customer identity when available.
- Use `budu-payment-safety`: redemption, mixed settlement, and refund are STRICT. The frontend never decides eligibility, balance, settlement success, or refund completion.
- Use `budu-mobile-ui` and `budu-brand-system` for admin, POS, QR, export, and electronic-card presentation.
- Use `budu-regression` after code changes. Candidate or production work must follow the current context and deployment gates.

## Core authority model

Keep the value account separate from credentials. The immutable ledger is the balance authority; a stored balance may only be a transactionally checked projection. Credentials contain a high-entropy namespaced secret, persist only its verifier/hash, and may be revoked or rotated without moving value or rewriting history.

Sweet Card is an internal tender, not a WeChat/Alipay/Cash provider and not a second Order system. Order settlement must reconcile exactly in integer cents across Sweet Card redemption and the remaining canonical Payment settlement. Item eligibility and tender allocation are frozen at checkout and reused for refund allocation.

## Fail-closed checks

At the server boundary require the dedicated Sweet Card capability for management, or the real `store-pos` capability for redemption, plus eligible-store policy. Reject inactive, expired, frozen, lost, exhausted, void credentials; REQUIRED cards without a canonical binding; blacklisted `ProductCategory.id`; a second Sweet Card on one order; replay/double spend; and any refund that could restore value twice or to another tender.

Never log or return raw credential secrets except once in an explicitly authorized create/export/replace flow. Never infer identity from recipient labels, infer category/store eligibility from names, or edit balances directly.

## Production boundary

The production feature flag defaults OFF. Candidate completion, migrations, generated test cards, or merchant readiness do not authorize production deployment, enablement, or creation of cards with real value.
