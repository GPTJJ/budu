---
name: budu-handoff
description: Use automatically when the user changes computer, starts a new Codex conversation, asks to continue previous BUDU work, resumes after context compaction, or requests a task handoff. Use with budu-context for recovery; do not rely on old conversation history as authority.
---

# BUDU Handoff

Before ending or transferring work, record current repository facts: remote, branch, HEAD, upstream status, working-tree changes, unpushed commits, active task, completed work, remaining work, and the last verified production SHA/migration when relevant.

Explicitly state:

- uncommitted work cannot be recovered from another device through Git;
- committed but unpushed work is also unavailable remotely;
- unknown local changes were preserved and excluded;
- production claims retain their verification date and status.

On a new device, fetch all refs with prune and recover from remote Git plus current production facts. Do not rely on an old Codex conversation or one machine’s local state. If remote Git, a handoff note, and production disagree, prefer current direct facts and report the conflict.

Keep stable recovery facts concise in `docs/BUDU_STATUS.md`. Put task-specific details in an appropriate checkpoint or handoff report rather than turning the status index into a chronological log.
