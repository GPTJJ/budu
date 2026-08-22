-- WeChat Pay R1: 崩溃恢复 + 跨进程核对租约（additive，仅新增列）
ALTER TABLE "payments"
  ADD COLUMN "network_attempt_started_at" TIMESTAMP(3),
  ADD COLUMN "reconcile_lease_owner" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "reconcile_lease_until" TIMESTAMP(3);

CREATE INDEX "payments_lease_idx"
  ON "payments"("provider", "status", "reconciliation_required", "reconcile_lease_until");
