-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'pending';

-- CreateIndex
CREATE INDEX "Invoice_storeKey_status_idx" ON "Invoice"("storeKey", "status");
