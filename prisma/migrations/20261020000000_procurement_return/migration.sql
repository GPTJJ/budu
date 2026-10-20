-- Additive only. No inventory, purchase receipt, store status or historical writes.
CREATE TABLE "ProcurementReturn" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "number" TEXT NOT NULL UNIQUE,
  "status" TEXT NOT NULL DEFAULT 'PROCESSING' CHECK ("status" IN ('PROCESSING','PENDING','COMPLETED')),
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
  "content" JSONB NOT NULL,
  "confirmedContent" JSONB,
  "storeKeys" TEXT[] NOT NULL,
  "createdById" TEXT NOT NULL,
  "createdByName" TEXT NOT NULL,
  "submittedByName" TEXT,
  "submittedAt" TIMESTAMP(3),
  "confirmedById" TEXT,
  "confirmedByName" TEXT,
  "confirmedAt" TIMESTAMP(3),
  "createRequestKey" TEXT NOT NULL UNIQUE,
  "createPayloadHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "ProcurementReturn_status_createdAt_idx" ON "ProcurementReturn"("status", "createdAt");
CREATE INDEX "ProcurementReturn_storeKeys_idx" ON "ProcurementReturn" USING GIN ("storeKeys");
CREATE TABLE "ProcurementReturnProduct" (
  "returnId" TEXT NOT NULL REFERENCES "ProcurementReturn"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "itemId" TEXT NOT NULL REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  PRIMARY KEY ("returnId", "itemId")
);
CREATE INDEX "ProcurementAudit_entityId_createdAt_idx" ON "ProcurementAudit"("entityId", "createdAt");
