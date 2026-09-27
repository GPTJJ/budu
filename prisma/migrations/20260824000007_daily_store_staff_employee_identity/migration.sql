-- Gate 6: add a stable Employee identity alongside the legacy synthetic staff_id.
-- Existing attendance rows remain unresolved with employee_id = NULL.
ALTER TABLE "daily_store_staff" ADD COLUMN "employee_id" TEXT;

CREATE UNIQUE INDEX "daily_store_staff_store_id_date_employee_id_key"
  ON "daily_store_staff"("store_id", "date", "employee_id");

ALTER TABLE "daily_store_staff"
  ADD CONSTRAINT "daily_store_staff_employee_id_fkey"
  FOREIGN KEY ("employee_id") REFERENCES "employees"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
