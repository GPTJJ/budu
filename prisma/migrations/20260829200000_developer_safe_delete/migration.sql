ALTER TABLE "User"
  ADD COLUMN "sensitive_failed_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "sensitive_attempt_window_started_at" TIMESTAMP(3),
  ADD COLUMN "sensitive_locked_until" TIMESTAMP(3);

ALTER TABLE "TransferRequest" ADD COLUMN "deletedAt" TIMESTAMP(3), ADD COLUMN "deletedBy" TEXT NOT NULL DEFAULT '', ADD COLUMN "deleteReason" TEXT NOT NULL DEFAULT '';
ALTER TABLE "PurchaseRequest" ADD COLUMN "deletedAt" TIMESTAMP(3), ADD COLUMN "deletedBy" TEXT NOT NULL DEFAULT '', ADD COLUMN "deleteReason" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Invoice" ADD COLUMN "deletedAt" TIMESTAMP(3), ADD COLUMN "deletedBy" TEXT NOT NULL DEFAULT '', ADD COLUMN "deleteReason" TEXT NOT NULL DEFAULT '';
ALTER TABLE "MailingRecord" ADD COLUMN "deletedAt" TIMESTAMP(3), ADD COLUMN "deletedBy" TEXT NOT NULL DEFAULT '', ADD COLUMN "deleteReason" TEXT NOT NULL DEFAULT '';
ALTER TABLE "PartnerSupplyOrder" ADD COLUMN "deletedAt" TIMESTAMP(3), ADD COLUMN "deletedBy" TEXT NOT NULL DEFAULT '', ADD COLUMN "deleteReason" TEXT NOT NULL DEFAULT '';

CREATE TABLE "sensitive_record_audits" (
  "id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "record_type" TEXT NOT NULL,
  "record_id" TEXT NOT NULL,
  "actor_user_id" TEXT NOT NULL,
  "actor_username" TEXT NOT NULL,
  "reason" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sensitive_record_audits_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TransferRequest_deletedAt_createdAt_idx" ON "TransferRequest"("deletedAt", "createdAt");
CREATE INDEX "PurchaseRequest_deletedAt_createdAt_idx" ON "PurchaseRequest"("deletedAt", "createdAt");
CREATE INDEX "Invoice_deletedAt_createdAt_idx" ON "Invoice"("deletedAt", "createdAt");
CREATE INDEX "MailingRecord_deletedAt_createdAt_idx" ON "MailingRecord"("deletedAt", "createdAt");
CREATE INDEX "PartnerSupplyOrder_deletedAt_businessDate_idx" ON "PartnerSupplyOrder"("deletedAt", "businessDate");
CREATE INDEX "sensitive_record_audits_record_type_record_id_created_at_idx" ON "sensitive_record_audits"("record_type", "record_id", "created_at");
CREATE INDEX "sensitive_record_audits_actor_user_id_created_at_idx" ON "sensitive_record_audits"("actor_user_id", "created_at");
