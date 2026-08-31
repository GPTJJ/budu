# Payroll Audit Report 2.0

Read this reference only for multi-format or scheduled payroll audits.

## One Result, Three Renderers

Create exactly one canonical report model from a single read-only Payroll authority snapshot. It contains audit metadata, stable employee scope, requested/effective period, mode, production SHA, summary, employee results, payable hours, Payroll and Personnel-card cents, dynamic components, daily reconciliation, Schedule comparison, issues, amount impact, options and final recommendation.

Markdown, PDF and email are renderers. They must not query Production, invoke another payroll formula or redistribute amounts. Bind all outputs with the same `runId` and `canonicalHash`; attach the PDF and Markdown from that run only.

## Two Layers

- Management summary: scope, period, final result, authority/card totals, difference, PASS/REVIEW/BLOCKED counts, issue count, settlement-review recommendation and zero-modification declaration.
- Evidence: per-employee dynamic components, every in-scope day, actual/payable-hours authority, Schedule comparison, issue layer/root cause/impact and non-executed resolution options.

PDF is portrait, single-column and mobile-readable. Use compact cards rather than wide tables, correct embedded/system CJK fonts, restrained BUDU Pink, status colors and explicit page breaks. Render to images and inspect every page before delivery.

Email contains only the management summary. The current automatic recipient is `yuegu1995@gmail.com`; do not add CC/BCC or employee recipients. Attach both the PDF and Markdown. Do not log detailed pay or publish artifacts.

## Monthly Automation

On the first day of each month in `Asia/Shanghai`, audit the previous complete calendar month in `FINAL` mode. Reuse one existing scheduler. A stable run identity is derived from period, scope, mode, Production SHA and authority digest. Duplicate triggers reuse the same run. Email retry reuses the same artifacts and never reruns Payroll.

If Payroll is BLOCKED, generate and send the truthful BLOCKED report. If report generation itself fails, send only a minimal execution-failed notice. Store artifacts and delivery manifests in a protected ignored directory; never commit real salary reports or credentials.
