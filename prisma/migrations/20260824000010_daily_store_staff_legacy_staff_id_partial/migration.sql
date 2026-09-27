-- Gate 16: DailyStoreStaff 稳定身份约束切换（约束/index-only，零数据变更）
--
-- 目标身份模型：
--   稳定行（employee_id IS NOT NULL）→ 唯一性由 (store_id, date, employee_id) 保证
--   legacy 行（employee_id IS NULL）  → 唯一性由 (store_id, date, staff_id) 部分唯一保证
--
-- 移除全量 (store_id, date, staff_id) unique（它错误地约束了稳定行，
-- 阻止同店/同日/同名但不同 employee_id 的稳定考勤行共存）。
-- 用 PostgreSQL partial unique index 保留 legacy NULL 行的 staffId 唯一保护。
-- 无任何 UPDATE/DELETE；既有数据逐字节保留。

DROP INDEX "daily_store_staff_store_id_date_staff_id_key";

CREATE UNIQUE INDEX "daily_store_staff_legacy_staff_id_key"
  ON "daily_store_staff"("store_id", "date", "staff_id")
  WHERE "employee_id" IS NULL;
