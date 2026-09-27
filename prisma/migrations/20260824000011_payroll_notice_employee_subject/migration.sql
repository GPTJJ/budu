-- Gate 18: PayrollNotice 稳定工资主体（employees.id）
-- 加性变更：employee_id 可空列 + FK RESTRICT + 稳定索引；保留全部历史快照字段。
-- 既有行保持 employee_id = NULL（不回填）。
-- 稳定行唯一性由应用层 (employeeId, periodType, periodKey) 保证（partial unique index 提供 DB 级保护）。

ALTER TABLE "payroll_notices" ADD COLUMN "employee_id" TEXT;

ALTER TABLE "payroll_notices"
  ADD CONSTRAINT "payroll_notices_employee_id_fkey"
  FOREIGN KEY ("employee_id") REFERENCES "employees"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "payroll_notices_employee_period_key"
  ON "payroll_notices"("employee_id", "period_type", "period_key")
  WHERE "employee_id" IS NOT NULL;

CREATE INDEX "payroll_notices_employee_id_period_type_period_key_idx"
  ON "payroll_notices"("employee_id", "period_type", "period_key");
