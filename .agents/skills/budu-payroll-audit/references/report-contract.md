# Payroll Audit Report Contract

Read this reference only when writing a formal persisted payroll audit.

Use this header for a single employee. For multi-employee scope, put scope/count in the header and repeat Payroll Summary and Daily Reconciliation per employee.

```markdown
# BUDU PAYROLL AUDIT REPORT

Employee: ...
Employee ID: ...
Business role: ...
Requested period: ...
Effective audit period: ...
Audit mode: PREVIEW / FINAL
Production SHA: ...
Authority: ...
Generated at: ...
```

## Payroll Summary

Report:

- Authoritative payable hours
- Authoritative payroll
- Employee card amount
- Difference, defined everywhere as `Employee card - Authoritative payroll`
- Payroll calculation: `PASS / MISMATCH / BLOCKED`
- Schedule reconciliation: `PASS / REVIEW`
- Final audit result: `PASS / REVIEW_REQUIRED / BLOCKED`

Use integer cents for comparison and format money only at the presentation boundary. Missing values are `—`, never zero.

## Payroll Components

Render every component returned by the current Payroll authority, not a permanently hard-coded field list:

| Component | Amount | Authority |
|---|---:|---|
| ... | ¥... | ... |
| Total | ¥... | Payroll authority |

If the authority adds a lawful component, include it even when this reference does not name it.

## Daily Reconciliation

At minimum:

| Date | Store | Planned Schedule | Actual Attendance | Payable Hours | Authority | Result |
|---|---|---|---|---:|---|---|

Use `NO_ACTUAL_ATTENDANCE` for a day without work. Do not turn it into an error without another required fact showing it should exist.

For a Schedule difference, state `Schedule difference`, `Payroll impact`, and why.

## Issues

If none, write `NONE`. Otherwise give stable issue IDs and include:

- Issue and type
- Date/store/employee
- Evidence
- Root cause, or `UNRESOLVED`
- Payroll impact
- Amount impact, exact when authority can establish it and otherwise `UNKNOWN`

## Resolution Options

For every issue include:

- Option A
- Option B when a genuine alternative exists
- Recommended option, only when evidence supports one
- Risk
- Required confirmation
- `NO ACTION EXECUTED`

End the report with `No production changes were performed.` Do not include passwords, tokens, webhook URLs, credentials, or full private attachments.
