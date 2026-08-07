-- CreateTable
CREATE TABLE "MeituanStoreMapping" (
    "id" TEXT NOT NULL,
    "meituanStoreId" TEXT NOT NULL,
    "storeKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MeituanStoreMapping_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MeituanStoreMapping_meituanStoreId_key" ON "MeituanStoreMapping"("meituanStoreId");

-- CreateTable
CREATE TABLE "DailySales" (
    "id" TEXT NOT NULL,
    "storeKey" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "incCents" BIGINT NOT NULL DEFAULT 0,
    "ord" INTEGER NOT NULL DEFAULT 0,
    "refundCents" BIGINT NOT NULL DEFAULT 0,
    "channels" JSONB NOT NULL DEFAULT '[]',
    "source" TEXT NOT NULL DEFAULT 'meituan',
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DailySales_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DailySales_storeKey_date_key" ON "DailySales"("storeKey", "date");

-- CreateTable
CREATE TABLE "DishDaily" (
    "id" TEXT NOT NULL,
    "storeKey" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "dishName" TEXT NOT NULL,
    "productName" TEXT NOT NULL DEFAULT '',
    "sales" INTEGER NOT NULL DEFAULT 0,
    "amountCents" BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT "DishDaily_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DishDaily_storeKey_date_dishName_key" ON "DishDaily"("storeKey", "date", "dishName");

-- CreateTable
CREATE TABLE "DishMapping" (
    "id" TEXT NOT NULL,
    "dishName" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DishMapping_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DishMapping_dishName_key" ON "DishMapping"("dishName");

-- CreateTable
CREATE TABLE "MeituanSyncLog" (
    "id" TEXT NOT NULL,
    "meituanStoreId" TEXT NOT NULL DEFAULT '',
    "storeKey" TEXT NOT NULL DEFAULT '',
    "day" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'ok',
    "message" TEXT NOT NULL DEFAULT '',
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MeituanSyncLog_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "MeituanStoreMapping" ADD CONSTRAINT "MeituanStoreMapping_storeKey_fkey" FOREIGN KEY ("storeKey") REFERENCES "Store"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailySales" ADD CONSTRAINT "DailySales_storeKey_fkey" FOREIGN KEY ("storeKey") REFERENCES "Store"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DishDaily" ADD CONSTRAINT "DishDaily_storeKey_fkey" FOREIGN KEY ("storeKey") REFERENCES "Store"("key") ON DELETE CASCADE ON UPDATE CASCADE;
