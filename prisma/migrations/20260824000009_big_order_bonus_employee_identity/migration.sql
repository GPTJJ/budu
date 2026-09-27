-- Gate 10: BigOrderBonus 稳定员工身份（employees.id）
-- 加性变更：employee_id 可空列 + 索引；保留 staffKey/staffName/storeKey 历史快照。
-- 既有行保持 employee_id = NULL（不回填）；ON DELETE RESTRICT 保护历史奖金记录。
-- 注意：BigOrderBonus 模型无 @@map，物理表名为 "BigOrderBonus"。

ALTER TABLE "BigOrderBonus" ADD COLUMN "employee_id" TEXT;

ALTER TABLE "BigOrderBonus"
  ADD CONSTRAINT "BigOrderBonus_employee_id_fkey"
  FOREIGN KEY ("employee_id") REFERENCES "employees"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "BigOrderBonus_employee_id_createdAt_idx"
  ON "BigOrderBonus"("employee_id", "createdAt");
