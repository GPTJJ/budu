-- 小程序历史订单归档（只读）。
-- 只新增一张表，不改动既有结算/订单数据；导入由运维脚本幂等写入（按 pay_no upsert）。

CREATE TABLE "online_order_archive" (
    "id" TEXT NOT NULL,
    "pay_no" TEXT NOT NULL,
    "order_no" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL,
    "delivery_type" TEXT NOT NULL DEFAULT '',
    "store_name" TEXT NOT NULL DEFAULT '',
    "paid_cents" BIGINT NOT NULL DEFAULT 0,
    "goods_cents" BIGINT NOT NULL DEFAULT 0,
    "shipping_cents" BIGINT NOT NULL DEFAULT 0,
    "total_cents" BIGINT NOT NULL DEFAULT 0,
    "refund_cents" BIGINT NOT NULL DEFAULT 0,
    "items" JSONB NOT NULL DEFAULT '[]',
    "recipient_name" TEXT NOT NULL DEFAULT '',
    "recipient_phone" TEXT NOT NULL DEFAULT '',
    "recipient_address" TEXT NOT NULL DEFAULT '',
    "carrier" TEXT NOT NULL DEFAULT '',
    "tracking_no" TEXT NOT NULL DEFAULT '',
    "transaction_id" TEXT NOT NULL DEFAULT '',
    "paid_at" TIMESTAMP(3),
    "shipped_at" TIMESTAMP(3),
    "received_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL,
    "raw" JSONB NOT NULL DEFAULT '{}',
    "imported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "online_order_archive_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "online_order_archive_pay_no_key" ON "online_order_archive"("pay_no");
CREATE INDEX "online_order_archive_status_created_at_idx" ON "online_order_archive"("status", "created_at");
CREATE INDEX "online_order_archive_created_at_idx" ON "online_order_archive"("created_at");
