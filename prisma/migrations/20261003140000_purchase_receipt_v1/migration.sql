-- AlterTable
ALTER TABLE "InventoryItem" ADD COLUMN     "procurementSupplierId" TEXT,
ADD COLUMN     "purchaseEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ProcurementSupplier" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcurementSupplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcurementOrder" (
    "id" TEXT NOT NULL,
    "storeKey" TEXT,
    "supplierId" TEXT,
    "supplierNameSnapshot" TEXT NOT NULL DEFAULT '',
    "storeNameSnapshot" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "orderRevision" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT NOT NULL,
    "createdByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "orderedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "draftContent" JSONB NOT NULL DEFAULT '{}',
    "createRequestKey" TEXT NOT NULL,
    "createPayloadHash" TEXT NOT NULL,

    CONSTRAINT "ProcurementOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcurementOrderLine" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "productNameSnapshot" TEXT NOT NULL,
    "unitSnapshot" TEXT NOT NULL,
    "orderedQty" DECIMAL(18,3) NOT NULL,
    "linePosition" INTEGER NOT NULL,

    CONSTRAINT "ProcurementOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcurementReceipt" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "receivedDate" DATE NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "version" INTEGER NOT NULL DEFAULT 1,
    "registeredById" TEXT NOT NULL,
    "submittedById" TEXT NOT NULL,
    "submittedByName" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createRequestKey" TEXT NOT NULL,
    "createPayloadHash" TEXT NOT NULL,

    CONSTRAINT "ProcurementReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcurementReceiptLine" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "orderLineId" TEXT NOT NULL,
    "receivedQty" DECIMAL(18,3) NOT NULL,

    CONSTRAINT "ProcurementReceiptLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcurementAudit" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "orderId" TEXT,
    "action" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorName" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "before" JSONB,
    "after" JSONB,
    "operationKey" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcurementAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcurementNotificationEvent" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "submissionRevision" INTEGER NOT NULL,
    "recipientUserId" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcurementNotificationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProcurementOrder_createRequestKey_key" ON "ProcurementOrder"("createRequestKey");

-- CreateIndex
CREATE INDEX "ProcurementOrder_storeKey_status_createdAt_idx" ON "ProcurementOrder"("storeKey", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProcurementOrderLine_orderId_inventoryItemId_key" ON "ProcurementOrderLine"("orderId", "inventoryItemId");

-- CreateIndex
CREATE UNIQUE INDEX "ProcurementOrderLine_id_orderId_key" ON "ProcurementOrderLine"("id", "orderId");

-- CreateIndex
CREATE INDEX "ProcurementReceipt_orderId_status_idx" ON "ProcurementReceipt"("orderId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ProcurementReceipt_orderId_sequence_key" ON "ProcurementReceipt"("orderId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "ProcurementReceipt_orderId_createRequestKey_key" ON "ProcurementReceipt"("orderId", "createRequestKey");

-- CreateIndex
CREATE UNIQUE INDEX "ProcurementReceipt_id_orderId_key" ON "ProcurementReceipt"("id", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "ProcurementReceiptLine_receiptId_orderLineId_key" ON "ProcurementReceiptLine"("receiptId", "orderLineId");

-- CreateIndex
CREATE UNIQUE INDEX "ProcurementAudit_operationKey_key" ON "ProcurementAudit"("operationKey");

-- CreateIndex
CREATE INDEX "ProcurementAudit_orderId_createdAt_idx" ON "ProcurementAudit"("orderId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProcurementNotificationEvent_notificationId_key" ON "ProcurementNotificationEvent"("notificationId");

-- CreateIndex
CREATE UNIQUE INDEX "ProcurementNotificationEvent_receiptId_submissionRevision_r_key" ON "ProcurementNotificationEvent"("receiptId", "submissionRevision", "recipientUserId");

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_procurementSupplierId_fkey" FOREIGN KEY ("procurementSupplierId") REFERENCES "ProcurementSupplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementOrder" ADD CONSTRAINT "ProcurementOrder_storeKey_fkey" FOREIGN KEY ("storeKey") REFERENCES "Store"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementOrder" ADD CONSTRAINT "ProcurementOrder_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "ProcurementSupplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementOrderLine" ADD CONSTRAINT "ProcurementOrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "ProcurementOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementOrderLine" ADD CONSTRAINT "ProcurementOrderLine_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementReceipt" ADD CONSTRAINT "ProcurementReceipt_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "ProcurementOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementReceiptLine" ADD CONSTRAINT "ProcurementReceiptLine_receiptId_orderId_fkey" FOREIGN KEY ("receiptId", "orderId") REFERENCES "ProcurementReceipt"("id", "orderId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementReceiptLine" ADD CONSTRAINT "ProcurementReceiptLine_orderLineId_orderId_fkey" FOREIGN KEY ("orderLineId", "orderId") REFERENCES "ProcurementOrderLine"("id", "orderId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementNotificationEvent" ADD CONSTRAINT "ProcurementNotificationEvent_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "ProcurementReceipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "ProcurementOrderLine" ADD CONSTRAINT procurement_order_qty CHECK ("orderedQty" > 0 AND "orderedQty" <= 999999.999);
ALTER TABLE "ProcurementReceiptLine" ADD CONSTRAINT procurement_receipt_qty CHECK ("receivedQty" > 0 AND "receivedQty" <= 999999.999);
ALTER TABLE "ProcurementOrder" ADD CONSTRAINT procurement_order_state CHECK (status IN ('DRAFT','ORDERED','RECEIVING','CLOSED','CANCELLED'));
ALTER TABLE "ProcurementReceipt" ADD CONSTRAINT procurement_receipt_state CHECK (status IN ('PENDING','APPROVED','RETURNED'));
ALTER TABLE "ProcurementNotificationEvent" ADD CONSTRAINT procurement_delivery_state CHECK (status IN ('PENDING','SENDING','SENT','FAILED','UNKNOWN','SKIPPED'));
CREATE FUNCTION procurement_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RAISE EXCEPTION 'procurement audit is append-only'; END; $fn$;
CREATE TRIGGER procurement_audit_immutable BEFORE UPDATE OR DELETE ON "ProcurementAudit" FOR EACH ROW EXECUTE FUNCTION procurement_audit_immutable();
