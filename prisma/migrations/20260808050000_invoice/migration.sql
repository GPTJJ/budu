-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "storeKey" TEXT NOT NULL,
    "titleType" TEXT NOT NULL DEFAULT 'company',
    "companyName" TEXT NOT NULL DEFAULT '',
    "taxNo" TEXT NOT NULL DEFAULT '',
    "amountCents" BIGINT NOT NULL DEFAULT 0,
    "category" TEXT NOT NULL DEFAULT '其他',
    "email" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceCompany" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "taxNo" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceCompany_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceCompany_name_key" ON "InvoiceCompany"("name");

-- CreateIndex
CREATE INDEX "Invoice_storeKey_createdAt_idx" ON "Invoice"("storeKey", "createdAt");

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_storeKey_fkey" FOREIGN KEY ("storeKey") REFERENCES "Store"("key") ON DELETE CASCADE ON UPDATE CASCADE;
