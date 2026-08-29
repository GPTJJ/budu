---
name: budu-production-deploy
description: Use when a BUDU task explicitly requires candidate creation, deployment, production cutover, smoke testing, rollback preparation, or production verification. Do not invoke for ordinary local implementation that has no deployment or production scope.
---

# BUDU Production Deployment

Deployment authority must be explicit. A request to inspect, build, commit, or push does not by itself authorize production cutover.

Default release shape: clean scoped diff → relevant tests → production build → clean commit → normal push → exact-SHA candidate → internal/unrouted smoke → cutover only when the task risk and authorization allow → public smoke → preserve rollback assets.

Never force-push. Confirm exact Git SHA identity, health, and exactly one production writer at the relevant gates. Preserve unknown worktree changes and unrelated rollback assets.

FAST and STANDARD work may follow an explicitly requested normal deployment after proportional verification. STRICT work stops at a reviewed candidate by default and requires explicit reviewer approval for the production gate.

If a migration exists, establish backup, compatibility, reconciliation, and an executable rollback contract before cutover. Do not invent a new deployment path when a current verified runbook or release script already governs the target.
