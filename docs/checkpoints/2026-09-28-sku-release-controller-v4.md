# SKU Authority 1.0 — Gate 8A-v4 release transport checkpoint

Status: non-production release engineering only. This gate does not authorize or execute production Gate 8.

## Incident basis

Failed production workflow `36335509623` passed the complete Gate 8A-v3 read-only readiness at 2026-09-27T17:09:30Z, then aborted at 17:16:46Z with `UNEXPECTED_ERROR_DETAILS_SUPPRESSED`.

Gate 8R direct read-only production audit later proved:
- running/public authority remained exact old production SHA `5ad27a06d731fbc94de5ae3776060b4350b886e8`;
- `budu_bj006` remained 85 applied / 0 failed;
- old application Prisma `SELECT 1` passed;
- 178 product / 87 POS active / 113 any-channel / Gate 7 mapping digest / 153 online digest remained exact;
- no SKU assignment/alias tables existed;
- no release candidate/worker container, release image tag, release lock, or rollback root existed.

The observed duration matched the previous hard-coded 240-second `docker load` transport limit closely. Root cause classification for engineering purposes is **FIRST_RUNTIME_DOCKER_LOAD_TIMEOUT — HIGH confidence**, without claiming perfect causal proof from the suppressed exception.

## Gate 8A-v4 scope

Only the release transport path is changed.

- Runtime and migration image archives are still built from the exact authorized release SHA and inspected before production contact.
- Archive size and SHA-256 are revalidated immediately before transport.
- The old fixed `240s` image-load timeout is removed.
- Image-load timeout is deterministic from reviewed archive size:
  - minimum 600 seconds;
  - estimate = 180 seconds + archive bytes / 1 MiB/s;
  - maximum 1200 seconds.
- Runtime and migration image loads emit fixed, non-secret stage markers:
  - `SKU_IMAGE_LOAD_START`
  - `SKU_IMAGE_LOAD_COMPLETE`
  - `SKU_IMAGE_LOAD_TIMEOUT`
  - `SKU_IMAGE_LOAD_FAILED`
- Timeout is converted to an explicit fail-closed code requiring read-only audit before any retry:
  - `SKU_RUNTIME_IMAGE_LOAD_TIMEOUT_AUDIT_REQUIRED`
  - `SKU_MIGRATION_IMAGE_LOAD_TIMEOUT_AUDIT_REQUIRED`
- Each remote image load is also wrapped by the production host's coreutils `timeout` with TERM + 30-second kill-after; the local SSH timeout is deliberately later, so the remote load receives the first bounded termination signal.
- The outer GitHub deploy timeout is extended from 25 minutes to 90 minutes so both bounded transports plus the already-reviewed remote controller can complete without the wrapper becoming the first timeout authority.

No schema, migration SQL, SKU business logic, Product Center, Inventory, Partner, Transfer, POS, mini-program code, production baseline authority, Gate 8B SAFE_DEGRADED behavior, or rollback state machine is changed.

## Safety ordering

Gate 8A-v3 ordering remains authoritative:

1. pure read-only production readiness, including proof that the host `timeout` command is available;
2. exact artifact/candidate-name admission;
3. release lock;
4. bounded image transport;
5. exact loaded-image identity and migration SQL checksum;
6. full baseline recheck;
7. remote controller;
8. only then old-writer stop / frozen plan / backup / restore rehearsal / 85→86 migration.

Any image timeout occurs before remote controller handoff and therefore before rollback-root creation, writer stop, backup, migration, or route cutover. A timeout must not be retried blindly; Gate 8R read-only evidence is required first.

## Required non-production validation

The v4 build-only workflow must pass:
- release identity / migration checksum / old post-transfer schema denial;
- Gate 8A-v3 readiness and zero-mutation failure tests;
- new transport timeout-budget, stage-marker, timeout classification, failure classification, and archive-drift tests;
- Gate 8B PostgreSQL 16 SAFE_DEGRADED;
- SKU authority atomicity;
- release data adapter and reconciliation;
- historical/order preservation;
- pre-cutover restore rehearsals;
- production build;
- exact production-format image inspection;
- clean worktree guard.

Production remains unchanged until a new exact v4 release SHA receives separate Gate 8 authorization.
