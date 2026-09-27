-- Partner Replenishment Gate 2: additive Partner domain/lifecycle foundation.
-- Existing inactive Partner rows remain unable to create business by mapping
-- the legacy boolean to PAUSED. No PartnerUser or Partner Supply facts change.
ALTER TABLE "Partner"
  ADD COLUMN "companyName" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "cooperationStartDate" DATE,
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "invoiceTitle" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "taxpayerId" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "contractReference" TEXT NOT NULL DEFAULT '';

UPDATE "Partner" SET "status" = 'PAUSED' WHERE "isActive" = FALSE;

ALTER TABLE "Partner"
  ADD CONSTRAINT "Partner_status_check"
  CHECK ("status" IN ('ACTIVE', 'PAUSED', 'TERMINATED'));

CREATE INDEX "Partner_status_name_idx" ON "Partner"("status", "name");

CREATE TABLE "PartnerStore" (
  "id" TEXT NOT NULL,
  "partnerId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "contactName" TEXT NOT NULL DEFAULT '',
  "phone" TEXT NOT NULL DEFAULT '',
  "province" TEXT NOT NULL DEFAULT '',
  "city" TEXT NOT NULL DEFAULT '',
  "district" TEXT NOT NULL DEFAULT '',
  "addressLine" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdById" TEXT NOT NULL DEFAULT '',
  "updatedById" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PartnerStore_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PartnerStore_status_check" CHECK ("status" IN ('ACTIVE', 'INACTIVE')),
  CONSTRAINT "PartnerStore_partnerId_fkey"
    FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "PartnerStore_partnerId_name_key" ON "PartnerStore"("partnerId", "name");
CREATE INDEX "PartnerStore_partnerId_status_name_idx" ON "PartnerStore"("partnerId", "status", "name");

CREATE TABLE "PartnerAuditLog" (
  "id" TEXT NOT NULL,
  "partnerId" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "before" JSONB,
  "after" JSONB,
  "actorUserId" TEXT NOT NULL,
  "actorUsername" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PartnerAuditLog_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PartnerAuditLog_partnerId_fkey"
    FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "PartnerAuditLog_partnerId_createdAt_idx" ON "PartnerAuditLog"("partnerId", "createdAt");
CREATE INDEX "PartnerAuditLog_entityType_entityId_createdAt_idx" ON "PartnerAuditLog"("entityType", "entityId", "createdAt");
