-- 门店可自行作废误下的待支付订单；保留操作人、时间和原因，订单本身不删除。
ALTER TABLE "orders"
  ADD COLUMN "cancelled_at" TIMESTAMP(3),
  ADD COLUMN "cancelled_by" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "cancel_reason" TEXT NOT NULL DEFAULT '';
