---
name: budu-payroll-audit
description: Use automatically when the user asks whether one or more BUDU employees' payroll is calculated correctly for a day or period, including payroll amount, payable hours, components, or comparison with the Personnel employee card. Always STRICT and read-only. Do not use for how much was paid, what remains owed, bank transfers, or payroll settlement reconciliation.
---

# BUDU Payroll Audit

Answer: “根据当前 BUDU 权威事实，这个员工在这个周期的工资算得对不对？” This skill is an independent audit, never a repair workflow.

Start with `BUDU task mode: STRICT — payroll calculation and attendance authority audit.` Compose with `budu-context`, `budu-data-authority`, and `budu-regression`; use `budu-handoff` when recording or transferring a completed audit. Do not repeat their general engineering rules.

## Permanent Boundary

**AUDIT IS NOT REPAIR.** Remain read-only even when an error is certain. Never change payroll code, Employee, Schedule, DailyEntry, DailyStoreStaff, actual/payable hours, adjustments, bonuses, PayrollNotice, employee-card data, schema, migrations, or Production. Do not issue payroll or send notifications. Findings lead only to evidence, impact, options, and required confirmation.

This skill audits calculated payroll. It does not determine money already paid, money still owed, bank transfers, or settlement status. Do not subtract PayrollNotice by default. If the user asks for settlement reconciliation, state that it is outside this skill and route to a dedicated settlement workflow if one exists.

## Resolve Scope

Parse `employee`, `date` or inclusive `periodStart/periodEnd`, `scope` (single, multiple, all), and `auditMode`.

- Resolve relative dates with the execution-time canonical BUDU business date and store timezone; never hard-code a month or year.
- Default an unfinished current-period request to `PREVIEW`: exclude the current business day and show the requested period plus effective cutoff. The current day is `IN_PROGRESS`, not missing.
- Use `FINAL` when the user explicitly asks for final/month-end/pre-settlement audit. Cover the complete requested period; do not skip the last day.
- If a natural-language period is ambiguous after checking current context, ask rather than silently choosing a year or range.

## Identity and Authority

Resolve a name through the current Employee directory only when it produces exactly one lawful `Employee.id`. Zero or multiple matches return `IDENTITY_REVIEW_REQUIRED`; never infer identity from names, snapshots, Schedule, or legacy rows.

Discover and invoke the current authoritative Payroll range resolver/service. Do not reproduce its formula in the skill, SQL, JavaScript, or a spreadsheet. Discover current output components instead of maintaining a fixed component list.

For every in-scope business day, inspect the canonical DailyEntry and DailyStoreStaff facts:

- confirmed/draft/missing DailyEntry and store/business date;
- stable `employeeId`, participant type, `actualHours`, and tagged payable-hours authority such as `ACTUAL_HOURS` or the currently approved `LEGACY_PAYROLL_HOURS`;
- relevant adjustments, bonuses, revisions, and audit trail;
- resolver-selected payable hours and payroll components.

Never substitute Schedule hours, default 8h, current store, or a display name for missing payroll facts. Missing/invalid required facts fail closed.

## Schedule Cross-check

Schedule is plan, not payroll authority. Compare it to actual attendance using stable IDs and classify `MATCH`, `SCHEDULE_ONLY`, `ACTUAL_ONLY`, `STORE_CHANGED`, `HOURS_DIFFERENCE`, `SHIFT_CHANGED`, `LEGACY_SCHEDULE_IDENTITY`, or `UNRESOLVED`.

A Schedule difference does not by itself make payroll wrong. When confirmed DailyStoreStaff identity and payable hours legally explain the actual work, payroll may PASS while Schedule reconciliation remains REVIEW. A historical Schedule without employeeId is `LEGACY_SCHEDULE_IDENTITY`; never map it by name.

## Employee Card Reconciliation

Trace the current Personnel employee-card server API, DTO, and projection on the audited baseline. Do not OCR a screenshot, scrape display text, or recompute the card value in the frontend.

Compare integer cents:

- authoritative payroll amount;
- employee-card displayed amount;
- `differenceCents = employeeCardCents - authoritativePayrollCents`.

Zero is `MATCH`; any nonzero difference, including one cent, is `MISMATCH`. Locate the responsible layer rather than stopping at the mismatch.

## Result and Diagnosis

Return one top-level result per employee:

- `PASS`: payroll authority is complete, card amount matches, and no unresolved issue affects payroll. A fully explained Schedule difference may remain a separate review note.
- `REVIEW_REQUIRED`: an amount can be calculated, but a discrepancy or unexplained fact needs confirmation.
- `BLOCKED`: required identity, DailyEntry, attendance, payable-hours, or Payroll authority is missing/invalid, so the correct amount cannot be established.

Diagnose mismatches using the evidence layer, including actual-hours aggregation, date range, DailyEntry coverage, missing bonus/adjustment, duplicate component, Payroll authority, employee-card projection/DTO/cache, identity, rounding, or another explicitly evidenced cause.

Cardbara is a normal auditable employee/business participant with business role `老板替班`. Do not exclude it or relax identity, attendance, or completeness rules.

## Formal Audit

For a formal audit, read [references/audit-procedure.md](references/audit-procedure.md) before querying facts. Read [references/report-contract.md](references/report-contract.md) before writing the persistent report.

Persist formal reports under the repository's current audit convention, preferring `docs/audits/payroll/`. Use stable, non-secret filename identifiers; do not invent a permanent name-to-pinyin mapping. Multi-employee audits must continue auditing other employees when one is blocked.

Every issue includes evidence, root cause or clearly marked unknown, payroll and amount impact, safe options, recommendation when justified, risk, and required confirmation. End with `NO ACTION EXECUTED` and `No production changes were performed.`
