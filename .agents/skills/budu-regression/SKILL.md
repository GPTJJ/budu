---
name: budu-regression
description: Use automatically after BUDU code changes to choose the smallest sufficient test and regression scope from the actual diff and affected business domain. Avoid unrelated full-system regression unless shared core code or a high-risk domain is changed.
---

# BUDU Regression Selection

Inspect the actual diff and affected dependencies before selecting tests. “Enough testing” does not mean “all tests every time.” Always include a production build for application code changes unless the task explicitly concerns non-runtime configuration only.

## Typical Scope

- ProductCenter CSS/UI: product-center UI, responsive/mobile behavior, and build.
- Transfer: create/process/export, product authority if touched, related notification, and build.
- CustomerRequest: affected request type, notification, deep link, relevant history, and build.
- Payroll: relevant full payroll fixtures, `Employee.id`, payable hours, issue/export, reconciliation; STRICT.
- Payment/Refund: payment, refund, POS, accounting, idempotency, reconciliation, provider regression; STRICT.

Expand coverage when a shared component, API contract, canonical model, permission primitive, deployment primitive, or cross-domain utility changed. Keep failures from stale or unrelated tests clearly separated, but do not dismiss a failure that could be caused by the diff.

For documentation/team-skill-only changes, validate the changed format, discovery, routing examples, and diff cleanliness; do not run unrelated business suites.
