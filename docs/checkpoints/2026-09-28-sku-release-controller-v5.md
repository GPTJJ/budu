# SKU Authority 1.0 — Gate 8A-v5 controller repair

Status: non-production candidate for Command Center review. Gate 8 remains HOLD.

The v4 incident (`36339430629`, SHA `4dee331f45e8cd4dca7f092a60213dbb99c4921c`) stopped the old writer before the frozen-plan worker first tried its database connection. The old runtime's `HostConfig.NetworkMode` was `budu_default`, while `DATABASE_URL` host `bj006-postgres` was an alias on a separate shared PostgreSQL network. The remote wrapper then read rollback state from the operations object instead of `ReleaseController.rollback_outcome`, obscuring the successful pre-cutover recovery.

The v5 worker resolves one network from the parsed database hostname, PostgreSQL container aliases, and networks shared with the old runtime. Missing, ambiguous, invalid, or unattached authority fails closed. The same resolver and environment construction serve both the pre-stop read-only Prisma `SELECT 1` probe and subsequent workers. The probe runs before rollback-root creation and before old-writer stop; a failure cannot enter the mutable release state machine. The old application's network mode remains relevant to candidate clone parity, but is no longer used as worker database network authority.

The wrapper retains the controller instance and reports its rollback outcome for PRE_CUTOVER, POST_CUTOVER SAFE_DEGRADED, and DATA_INTEGRITY_HOLD. It also emits a fixed stage, exception class, and allowlisted failure code, with no exception message, database URL, environment, or stderr. The primary error remains recorded even if rollback encounters a later error. Unknown rollback remains unverified.

The build-only workflow is pinned to the isolated v5 branch and PostgreSQL 16. No schema, migration, SKU mapping, business runtime, inventory behavior, production infrastructure, or production database is changed by this engineering candidate. The v4 incident rollback root and exact images remain untouched. A new production Gate 8 requires separate review and authorization after exact-SHA CI and fresh production readiness.
