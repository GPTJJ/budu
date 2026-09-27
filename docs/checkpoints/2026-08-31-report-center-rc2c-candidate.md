# Report Center V1 RC-2C Candidate

Evidence status: VERIFIED unless explicitly marked otherwise.

## Authority and scope

- Base SHA: `c511322496e6e1c46f09a2aa63c11e3a181e8c09`.
- Candidate branch: `codex/report-center-rc2c-candidate`.
- Production and authoritative SHA remained `4a25cd49d373c442543af5063928daf73715bb55`.
- Production authority remained `budu_bj006`, ledger 58, failed migrations 0 and one active writer.
- Production was read only. Migrations 59/60 were not applied to Production and no deployment occurred.
- Migration 61 was not created; Prisma schema and migrations are unchanged from RC-2B.
- Alipay Candidate `248607b83c74514376c29edd6aa56acdb24fad30` is not an ancestor and was not merged.

## Platform-order POS authority

- POS exposes a separate, capability-gated “平台订单” checkout group for MEITUAN,
  TAOBAO_FLASH, JD_INSTANT and OTHER/CUSTOM.
- The client sends a narrow source intent. Server-owned mapping derives `MANUAL_POS`, `EXTERNAL`
  and PLATFORM/CUSTOM; clients cannot submit settlement authority, status or entry mode.
- One transaction creates and confirms Order plus ExternalSettlement when the actor has both
  capabilities. No platform order number or custom-label schema is required.
- A BUDU request key remains stable across duplicate clicks and network retries.
- Platform checkout creates zero Payment rows and makes zero payment-provider invocations.
- Existing cash/WeChat checkout remains on PAYMENT authority and creates no ExternalSettlement.

## Manual external refund UX

- External-authority order details show “记录平台退款”; PAYMENT-authority orders retain the
  existing refund action and provider behavior.
- The UI submits selected OrderItem quantities, the actual external refund total and the external
  completion time. RefundItem allocation remains exclusively server-side and BigInt deterministic.
- The UI states that the external platform refund must already have completed and does not offer
  inventory restoration or COGS reversal.
- Partial and full refunds derive the existing ExternalSettlement and Order statuses while retaining
  original sales facts.
- Record/confirm actions read the two frozen capabilities; no role receives new default grants.

## Regression evidence

- Isolated PostgreSQL 16 migration sequence 1→58→59→60: PASS. The temporary database was isolated
  from `budu_bj006` and removed after the run.
- RC-2C transactional workflow, four platform sources, idempotency, concurrent/over-refund guards,
  COGS/inventory equality and provider-call count 0: PASS.
- RC-2A and RC-2B workflow/allocation/migration rehearsals: PASS.
- Cash/WeChat provider, payment reconciliation and current Alipay state: PASS/preserved.
- Daily Entry V2, Payroll, orphan-dependency, permissions and role-capability regression: PASS.
- WebKit combined regression: 52/52 PASS, including 320/340/375/390/430 widths, iPad basics,
  nested overlay behavior and Pull-to-Refresh suppression while an overlay is open.
- Prisma validation, exact-decimal UI unit tests and production build: PASS.
- Production public health continued to report runtime SHA prefix `4a25cd49d373` and `dbOk=true`.

## Stop boundary

RC-2C is ready for independent review. Stop here: do not deploy Production, apply migrations 59/60,
merge authoritative mainline, create real platform orders/refunds, or start a Report Dashboard gate.
