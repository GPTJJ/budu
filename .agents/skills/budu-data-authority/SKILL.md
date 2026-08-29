---
name: budu-data-authority
description: Use automatically for BUDU tasks that create, change, migrate, read, reconcile, or identify business data, database models, employee identity, product identity, payroll inputs, historical records, or source-of-truth behavior. Do not use for display-only CSS or copy changes with no data implications.
---

# BUDU Data Authority

PostgreSQL is the canonical authority for BUDU business data. Compatibility stores, frontend caches, labels, and snapshots must not overwrite canonical identity or current facts.

## Stable Identity

- Employee: `Employee.id`.
- Self-account employee link: `User.employeeId → Employee.id`.
- Product: `InventoryItem.id`.
- Product classification: `ProductCategory`.
- POS eligibility, transfer eligibility, and partner-supply eligibility are business attributes of the same `InventoryItem`; do not create another product identity.

Do not use display names, employee names, or product names as business identity. Do not automatically merge IDs by name. Browser storage is UI state, never business authority.

## Historical Facts

Prefer stable IDs plus immutable snapshots for historical records. Disabling or renaming a current entity must not rewrite historical business facts. New features should consume an existing authority before adding fields or models.

Fail closed when identity or authority cannot be established. Historical rewrites, bulk corrections, destructive migrations, or authority transfers require STRICT mode, explicit scope, reconciliation, backup, and rollback evidence.
