-- Gate 9: DailyPayAdjustment 稳定员工身份（employees.id）
-- 加性变更：employee_id 可空列 + 稳定唯一 (employee_id, date)；保留 legacy (staff_name, date) 唯一。
-- 既有行保持 employee_id = NULL（不回填）；ON DELETE RESTRICT 保护历史调整记录。

ALTER TABLE "daily_pay_adjustments" ADD COLUMN "employee_id" TEXT;

ALTER TABLE "daily_pay_adjustments"
  ADD CONSTRAINT "daily_pay_adjustments_employee_id_fkey"
  FOREIGN KEY ("employee_id") REFERENCES "employees"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "daily_pay_adjustments_employee_id_date_key"
  ON "daily_pay_adjustments"("employee_id", "date");
