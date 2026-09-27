-- WEEK/CUSTOM stable-mainline integration:
-- persist every PayrollNotice as an exact inclusive business-date range.
-- Existing amount/snapshot/Employee.id fields are deliberately untouched.

ALTER TABLE "payroll_notices"
  ADD COLUMN "period_start" DATE,
  ADD COLUMN "period_end" DATE;

-- Existing MONTH rows are deterministic from YYYY-MM.
UPDATE "payroll_notices"
SET
  "period_start" = ("period_key" || '-01')::date,
  "period_end" = (("period_key" || '-01')::date + INTERVAL '1 month - 1 day')::date
WHERE "period_type" = 'month'
  AND "period_key" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$';

-- Existing WEEK authority is Monday -> Sunday.
UPDATE "payroll_notices"
SET
  "period_start" = "period_key"::date,
  "period_end" = ("period_key"::date + 6)
WHERE "period_type" = 'week'
  AND "period_key" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';

-- Existing CUSTOM authority is an explicit inclusive start~end key.
UPDATE "payroll_notices"
SET
  "period_start" = split_part("period_key", '~', 1)::date,
  "period_end" = split_part("period_key", '~', 2)::date
WHERE "period_type" = 'custom'
  AND "period_key" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}~[0-9]{4}-[0-9]{2}-[0-9]{2}$';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "payroll_notices"
    WHERE "period_start" IS NULL
       OR "period_end" IS NULL
       OR "period_start" > "period_end"
       OR ("period_type" = 'week' AND EXTRACT(ISODOW FROM "period_start") <> 1)
  ) THEN
    RAISE EXCEPTION 'PAYROLL_NOTICE_PERIOD_BACKFILL_NOT_PROVABLE';
  END IF;
END $$;

ALTER TABLE "payroll_notices"
  ALTER COLUMN "period_start" SET NOT NULL,
  ALTER COLUMN "period_end" SET NOT NULL,
  ADD CONSTRAINT "payroll_notices_period_order_check"
    CHECK ("period_start" <= "period_end"),
  ADD CONSTRAINT "payroll_notices_period_semantics_check"
    CHECK (
      (
        "period_type" = 'month'
        AND "period_key" = to_char("period_start", 'YYYY-MM')
        AND "period_start" = date_trunc('month', "period_start")::date
        AND "period_end" = (date_trunc('month', "period_start") + INTERVAL '1 month - 1 day')::date
      ) OR (
        "period_type" = 'week'
        AND "period_key" = to_char("period_start", 'YYYY-MM-DD')
        AND EXTRACT(ISODOW FROM "period_start") = 1
        AND "period_end" = "period_start" + 6
      ) OR (
        "period_type" = 'custom'
        AND "period_key" = to_char("period_start", 'YYYY-MM-DD') || '~' || to_char("period_end", 'YYYY-MM-DD')
      )
    );

-- Recalled/deleted notices do not represent payment under the existing product
-- contract, so they no longer occupy the exact-period uniqueness slot.
DROP INDEX IF EXISTS "payroll_notices_employee_period_key";
CREATE UNIQUE INDEX "payroll_notices_employee_period_key"
  ON "payroll_notices"("employee_id", "period_type", "period_key")
  WHERE "employee_id" IS NOT NULL AND "status" NOT IN ('recalled', 'deleted');

CREATE INDEX "payroll_notices_employee_id_period_start_period_end_idx"
  ON "payroll_notices"("employee_id", "period_start", "period_end");
