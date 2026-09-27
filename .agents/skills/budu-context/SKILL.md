---
name: budu-context
description: Use automatically when starting, resuming, handing off, or recovering context for a BUDU development task, especially in a new Codex conversation, on a new device, after context compaction, or when repository or production state may have changed. Do not use as a substitute for task-specific implementation or production verification.
---

# BUDU Context Recovery

Rebuild context from current facts rather than old chat memory.

## Lightweight Bootstrap

1. Read the applicable `AGENTS.md` files and `docs/BUDU_STATUS.md` when present.
2. Inspect `git remote`, fetch/prune current refs, branch, HEAD, upstream, status, recent commits, and relevant release/checkpoint documents.
3. Preserve unknown working-tree changes. Do not discard, reset, or stash them without authorization.
4. Read only the architecture, migration, and domain documents relevant to the requested work.
5. If production facts affect safety, verify runtime SHA, database authority, migration ledger, writer count, health, and rollback assets using safe read-only checks. Mark unavailable facts UNVERIFIED.

Never assume local HEAD equals production. Direct current runtime/database facts outrank Git; current Git outranks tests and status documents; documents outrank memory. If authorities conflict in a way that affects safe execution, report `AUTHORITY CONFLICT` and stop the affected work.

Use `docs/BUDU_STATUS.md` as a compact recovery index, not a permanent truth source. Update it only for meaningful architecture or production-baseline changes, with verification date and evidence state. Do not automatically execute a documented next action.
