-- 调货单允许使用单据级临时地点；临时地点名称永久保存在调货单，且不写入正式 Store 目录。
ALTER TABLE "TransferRequest"
  ALTER COLUMN "fromStoreKey" DROP NOT NULL,
  ALTER COLUMN "toStoreKey" DROP NOT NULL,
  ADD COLUMN "fromLocationName" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "toLocationName" TEXT NOT NULL DEFAULT '';

ALTER TABLE "TransferRequest"
  ADD CONSTRAINT "TransferRequest_from_endpoint_check"
  CHECK (("fromStoreKey" IS NOT NULL) <> (length(btrim("fromLocationName")) > 0)),
  ADD CONSTRAINT "TransferRequest_to_endpoint_check"
  CHECK (("toStoreKey" IS NOT NULL) <> (length(btrim("toLocationName")) > 0));
