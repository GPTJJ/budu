# BUDU Payroll Audit Skill Checkpoint

Date: 2026-09-01 (Asia/Shanghai)

Status: **READY — team Skill candidate**

## Git authority

- Base authoritative SHA: `ca8fa436ec6c7b7f2d8f627431b67cad8c1b53a8`
- Candidate branch: `codex/budu-payroll-audit-skill`
- Skill implementation commit: `6574a4087a85eedb0a35e373ea2aec59bded8b15`
- Remote branch state: implementation commit pushed; the final documentation-only handoff commit is the branch HEAD reported at completion
- Skill path: `.agents/skills/budu-payroll-audit/SKILL.md`

## Delivered contract

- `budu-task-router` routes payroll-calculation correctness questions to `budu-payroll-audit` as STRICT, including short natural-language requests.
- Paid/owed/bank-transfer questions remain payroll settlement reconciliation and are explicitly outside this Skill.
- The Skill is permanently read-only: audit findings may explain impact and options but cannot repair Payroll, attendance, identity, Schedule or Production facts.
- Employee identity is `Employee.id`; current Payroll resolver/service remains the only calculation authority.
- DailyEntry, DailyStoreStaff, actual/payable-hours facts, Schedule reconciliation, Personnel employee-card projection, exact-cent comparison, PREVIEW/FINAL semantics and persistent reports are covered.
- Cardbara remains a normal auditable subject with business-role note `老板替班` and no relaxed completeness rules.

## Verification

- Skill metadata validation: PASS (`quick_validate.py`).
- Routing contract: PASS, 6/6 (five payroll-audit prompts plus one settlement exclusion).
- Business contract: PASS, A–H scenarios, including Schedule/actual separation, missing facts, identity ambiguity, one-cent mismatch, PREVIEW/FINAL, Cardbara and zero mutation.
- Skill contract suite: PASS, 10/10.
- Referenced Payroll authority regression: resolver, readiness, payable-hours, employee-card projection and Cardbara isolation PASS.
- Diff scope: Skill, router, Skill tests and stable documentation only.

## Safety and unchanged authorities

- Payroll business code changed: no.
- Database schema or migration changed: no.
- Production business data changed: no.
- Production deployment: not applicable.
- Last directly verified Production baseline remains the status-document checkpoint (`3c7f56c6cc77573e252023b59e2dcdfd1522678d`, `budu_bj006`, migration 62); this Skill-only task did not re-query Production.

## Recovery instruction

Fetch `codex/budu-payroll-audit-skill`, verify its remote SHA and clean worktree, then run the repository Skill validator and `npm run test:skill:payroll-audit`. Formal payroll audits should compose this Skill with `budu-context`, `budu-data-authority`, `budu-regression` and `budu-handoff`; they must establish fresh runtime/DB authority before reading Production facts.
