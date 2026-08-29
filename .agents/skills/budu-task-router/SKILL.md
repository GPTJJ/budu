---
name: budu-task-router
description: Use automatically for any task involving the BUDU repository, BUDU OS, POS, payroll, transfers, customer requests, product center, approvals, payments, deployment, database, or production changes. Classify the task as FAST, STANDARD, or STRICT before choosing the engineering workflow.
---

# BUDU Task Router

Classify the requested BUDU work before choosing tools, verification, or tests. Start with one concise sentence: `BUDU task mode: FAST|STANDARD|STRICT — <reason>`. Do not turn a FAST task into a long planning exercise.

## FAST

Use for UI, CSS, copy, small layouts, display-only frontend work, and clearly bounded bugs that do not touch critical data models.

Default flow: minimal diff → targeted tests → build → deploy only when the user explicitly requests it.

Do not automatically run payroll, payment, large data audits, or unrelated module regressions.

## STANDARD

Use for ordinary business logic such as transfers, approvals, product management, notifications, partner supply, CustomerRequest, exports, and routine permission changes.

Default flow: inspect the current implementation → make the smallest correct change → preserve affected data contracts → targeted regression → build → normal candidate or deployment only when authorized.

## STRICT

Use automatically for Payment, Refund, WeChat Pay, Alipay, payroll calculations, work hours, payroll issuance, production-data repair, authority migrations, destructive migrations, identity authority, high-risk deletion permissions, or large historical-data changes.

Default flow: strict audit → backup and rollback consideration → isolated candidate → reconciliation → reviewer gate. Do not perform production cutover unless the current user instruction explicitly authorizes that production gate.

## Route Only What Applies

- New or recovered context: `budu-context`.
- Business identity or source-of-truth work: `budu-data-authority`.
- Frontend/mobile work: `budu-mobile-ui`.
- Code changes: `budu-regression`.
- Candidate, deployment, cutover, or production verification: `budu-production-deploy`.
- Payment/refund work: always `budu-payment-safety` and STRICT.
- Device or conversation handoff: `budu-handoff`.

Do not load every BUDU skill for every task. The classification does not grant deployment, database-write, notification, or other external authority.
