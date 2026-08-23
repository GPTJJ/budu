-- WeChat Pay R3: 精确外键身份校验 + 规范化（payment_logs → RESTRICT）
--
-- 背景：00003 按「首个引用目标表的外键」定位约束，未证明源/目标列身份。
-- 本迁移（00004）改为通过 pg_constraint + pg_attribute 的 conkey/confkey
-- 属性序号精确匹配「源列 = payment_id/order_id、目标列 = id」的外键：
--   - 精确匹配数量必须恰好为 1；0 或 >1 一律 RAISE EXCEPTION 中止，绝不
--     删除「任意」外键（防止漂移/多外键时误删）。
--   - 仅对精确匹配的外键：DROP 后按规范名重建为 ON DELETE RESTRICT、
--     ON UPDATE CASCADE；无关外键一律不触碰。
-- 两对关系（payment_logs.payment_id → payments.id 与
-- payment_logs.order_id → orders.id）独立处理。

DO $$
DECLARE
  fk_payment TEXT;
  cnt_payment INT;
  fk_order TEXT;
  cnt_order INT;
BEGIN
  -- payment_logs.payment_id -> payments.id：精确匹配（conkey/confkey 列名）
  SELECT count(*) INTO cnt_payment
  FROM pg_constraint fk
  JOIN pg_attribute src ON src.attrelid = fk.conrelid AND src.attnum = fk.conkey[1]
  JOIN pg_attribute tgt ON tgt.attrelid = fk.confrelid AND tgt.attnum = fk.confkey[1]
  WHERE fk.contype = 'f'
    AND fk.conrelid = 'payment_logs'::regclass
    AND fk.confrelid = 'payments'::regclass
    AND array_length(fk.conkey, 1) = 1
    AND array_length(fk.confkey, 1) = 1
    AND src.attname = 'payment_id'
    AND tgt.attname = 'id';

  IF cnt_payment <> 1 THEN
    RAISE EXCEPTION 'payment_logs.payment_id -> payments.id 精确外键数量为 %（必须恰好为 1），迁移中止；数据库可能存在漂移', cnt_payment;
  END IF;

  SELECT fk.conname INTO fk_payment
  FROM pg_constraint fk
  JOIN pg_attribute src ON src.attrelid = fk.conrelid AND src.attnum = fk.conkey[1]
  JOIN pg_attribute tgt ON tgt.attrelid = fk.confrelid AND tgt.attnum = fk.confkey[1]
  WHERE fk.contype = 'f'
    AND fk.conrelid = 'payment_logs'::regclass
    AND fk.confrelid = 'payments'::regclass
    AND array_length(fk.conkey, 1) = 1
    AND array_length(fk.confkey, 1) = 1
    AND src.attname = 'payment_id'
    AND tgt.attname = 'id';

  EXECUTE format('ALTER TABLE "payment_logs" DROP CONSTRAINT %I', fk_payment);

  -- payment_logs.order_id -> orders.id：精确匹配
  SELECT count(*) INTO cnt_order
  FROM pg_constraint fk
  JOIN pg_attribute src ON src.attrelid = fk.conrelid AND src.attnum = fk.conkey[1]
  JOIN pg_attribute tgt ON tgt.attrelid = fk.confrelid AND tgt.attnum = fk.confkey[1]
  WHERE fk.contype = 'f'
    AND fk.conrelid = 'payment_logs'::regclass
    AND fk.confrelid = 'orders'::regclass
    AND array_length(fk.conkey, 1) = 1
    AND array_length(fk.confkey, 1) = 1
    AND src.attname = 'order_id'
    AND tgt.attname = 'id';

  IF cnt_order <> 1 THEN
    RAISE EXCEPTION 'payment_logs.order_id -> orders.id 精确外键数量为 %（必须恰好为 1），迁移中止；数据库可能存在漂移', cnt_order;
  END IF;

  SELECT fk.conname INTO fk_order
  FROM pg_constraint fk
  JOIN pg_attribute src ON src.attrelid = fk.conrelid AND src.attnum = fk.conkey[1]
  JOIN pg_attribute tgt ON tgt.attrelid = fk.confrelid AND tgt.attnum = fk.confkey[1]
  WHERE fk.contype = 'f'
    AND fk.conrelid = 'payment_logs'::regclass
    AND fk.confrelid = 'orders'::regclass
    AND array_length(fk.conkey, 1) = 1
    AND array_length(fk.confkey, 1) = 1
    AND src.attname = 'order_id'
    AND tgt.attname = 'id';

  EXECUTE format('ALTER TABLE "payment_logs" DROP CONSTRAINT %I', fk_order);
END $$;

ALTER TABLE "payment_logs" ADD CONSTRAINT "payment_logs_payment_id_fkey"
  FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payment_logs" ADD CONSTRAINT "payment_logs_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
