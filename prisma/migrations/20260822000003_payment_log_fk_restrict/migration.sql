-- WeChat Pay R2: payment_logs 外键由 ON DELETE CASCADE 收紧为 ON DELETE RESTRICT
--
-- 理由：PaymentLog 是支付审计记录，不得因订单/支付被删除而级联清除。
-- 约束名可能因历史/手工变更而异，故先用 DO 块按被引用表动态定位并删除，
-- 再以规范名重建为 RESTRICT（与 refunds 外键策略一致）。
--
-- 注意：先删除后重建在同一事务内完成，中间态不会被并发事务观察到。

DO $$
DECLARE
  fk_payment TEXT;
  fk_order   TEXT;
BEGIN
  -- payment_logs.payment_id → payments.id
  SELECT conname INTO fk_payment
    FROM pg_constraint
    WHERE conrelid = 'payment_logs'::regclass
      AND contype = 'f'
      AND confrelid = 'payments'::regclass
    ORDER BY conname
    LIMIT 1;
  IF fk_payment IS NOT NULL THEN
    EXECUTE format('ALTER TABLE "payment_logs" DROP CONSTRAINT %I', fk_payment);
  END IF;

  -- payment_logs.order_id → orders.id
  SELECT conname INTO fk_order
    FROM pg_constraint
    WHERE conrelid = 'payment_logs'::regclass
      AND contype = 'f'
      AND confrelid = 'orders'::regclass
    ORDER BY conname
    LIMIT 1;
  IF fk_order IS NOT NULL THEN
    EXECUTE format('ALTER TABLE "payment_logs" DROP CONSTRAINT %I', fk_order);
  END IF;
END $$;

ALTER TABLE "payment_logs" ADD CONSTRAINT "payment_logs_payment_id_fkey"
  FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payment_logs" ADD CONSTRAINT "payment_logs_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
