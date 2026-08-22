-- WeChat Pay V2 MICROPAY: 未决支付自动核对字段（additive，仅新增列）
ALTER TABLE "payments"
  ADD COLUMN "provider_status" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "query_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "last_queried_at" TIMESTAMP(3),
  ADD COLUMN "next_action_at" TIMESTAMP(3),
  ADD COLUMN "reconciliation_required" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "reconciled_at" TIMESTAMP(3);

CREATE INDEX "payments_reconciliation_idx"
  ON "payments"("provider", "status", "reconciliation_required", "next_action_at");
