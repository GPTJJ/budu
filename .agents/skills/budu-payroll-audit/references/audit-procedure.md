# Payroll Audit Procedure

Read this reference only when performing a formal payroll audit.

## 1. Establish Current Facts

1. Bootstrap repository/runtime context through `budu-context`.
2. Record exact Production runtime SHA, authoritative Git SHA, database authority, migration ledger, health, and query time. Mark unavailable facts `UNVERIFIED` rather than copying stale checkpoints.
3. Confirm that all Production queries can run in a database read-only transaction. If read-only safety cannot be established, stop.
4. Resolve the requested period using the canonical business date/timezone. Record both requested and effective period plus `PREVIEW` or `FINAL`.

## 2. Resolve Subjects

Read the current Employee directory. Resolve each requested subject to exactly one `Employee.id`; preserve the input/display name only as a label. Zero or multiple candidates stop that subject with `IDENTITY_REVIEW_REQUIRED`. For all-employee audits, build the subject set from current lawful payroll participants rather than name lists.

Cardbara is not a special exclusion. Display `老板替班` as its business-role note and apply the same completeness rules.

## 3. Capture Pre-audit Reconciliation

Capture stable counts and canonical digests for the in-scope facts supported by the current project, at minimum:

- DailyEntry;
- DailyStoreStaff;
- Employee;
- relevant adjustments and bonuses;
- Schedule when cross-checking it;
- any other Payroll input actually consumed by the resolver.

Do not include secrets or raw large attachments in the report.

## 4. Invoke Authorities

Invoke the current Payroll range authority for the exact effective range. Do not copy its formula. Preserve calculation readiness, blockers, employee rows, daily explanations, and dynamically discovered monetary components.

Separately trace the Personnel card projection from its server endpoint/service through DTO to UI. Read the authoritative response for the same employee and period. A cached card result must be identified as cached; re-fetch the canonical projection before declaring mismatch.

PayrollNotice is not an input for “what payroll should be.” Inspect it only when the user explicitly expands scope to issuance/settlement or when its immutable snapshot is itself the object being audited. Never subtract it silently.

## 5. Daily Evidence

For every day in the effective range:

- show confirmed/draft/missing DailyEntry state for relevant stores;
- show actual attendance or `NO_ACTUAL_ATTENDANCE`;
- show stable employeeId and payable-hours source;
- show Schedule comparison without using Schedule as actual attendance;
- show relevant bonus/adjustment and the Payroll authority's daily result.

In PREVIEW, current business day is `IN_PROGRESS` and outside the effective period. In FINAL, a missing required last-day fact is a blocker.

## 6. Diagnose and Classify

Use evidence to locate mismatches at the correct layer. Common classifications:

- `ACTUAL_HOURS_AGGREGATION_ERROR`
- `DATE_RANGE_ERROR`
- `DAILY_ENTRY_COVERAGE_ERROR`
- `BONUS_MISSING`
- `ADJUSTMENT_MISSING`
- `DUPLICATE_COMPONENT`
- `PAYROLL_AUTHORITY_ERROR`
- `EMPLOYEE_CARD_PROJECTION_ERROR`
- `DTO_ERROR`
- `CACHE_STALE_PROJECTION`
- `IDENTITY_ERROR`
- `ROUNDING_ERROR`
- `OTHER`

Do not force a category without evidence; use `OTHER` with an explicit unknown root cause.

## 7. Reconcile and Persist

Re-read the same facts after the audit and compare counts/digests. Any drift caused by the audit is `FAIL/HOLD`; stop and report it. Normal concurrent Production changes must be identified rather than attributed to the audit.

Write the report using `report-contract.md`. Never repair data during the audit.
