-- CreateTable
CREATE TABLE "MailingRecord" (
    "id" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "postage" TEXT NOT NULL,
    "fee" TEXT,
    "address" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "remark" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdBy" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "shippedAt" TIMESTAMP(3),

    CONSTRAINT "MailingRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MailingRecord_status_createdAt_idx" ON "MailingRecord"("status", "createdAt");
