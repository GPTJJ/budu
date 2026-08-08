-- CreateTable
CREATE TABLE "BigOrderBonus" (
    "id" TEXT NOT NULL,
    "staffKey" TEXT NOT NULL,
    "staffName" TEXT NOT NULL,
    "storeKey" TEXT NOT NULL,
    "amountCents" BIGINT NOT NULL DEFAULT 0,
    "bonusCents" BIGINT NOT NULL DEFAULT 0,
    "receipt" TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BigOrderBonus_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BigOrderBonus_staffKey_createdAt_idx" ON "BigOrderBonus"("staffKey", "createdAt");

-- CreateIndex
CREATE INDEX "BigOrderBonus_storeKey_createdAt_idx" ON "BigOrderBonus"("storeKey", "createdAt");

-- AddForeignKey
ALTER TABLE "BigOrderBonus" ADD CONSTRAINT "BigOrderBonus_storeKey_fkey" FOREIGN KEY ("storeKey") REFERENCES "Store"("key") ON DELETE CASCADE ON UPDATE CASCADE;
