-- RC-6A / migration 62: effective-dated rent, monthly utility and confirmed labor add-on facts.
CREATE TYPE "StoreRentMode" AS ENUM ('FIXED', 'PERCENT', 'FIXED_PLUS_PERCENT', 'MAX_FIXED_PERCENT');
CREATE TYPE "RentPercentageBasis" AS ENUM ('GROSS_SALES', 'NET_REVENUE');
CREATE TYPE "LaborCostCategory" AS ENUM ('SOCIAL_SECURITY', 'PROVIDENT_FUND', 'OTHER');

CREATE TABLE "store_rent_histories" (
  "id" TEXT NOT NULL,
  "store_key" TEXT NOT NULL,
  "mode" "StoreRentMode" NOT NULL,
  "fixed_amount_cents" BIGINT,
  "percentage_bps" INTEGER,
  "percentage_basis" "RentPercentageBasis",
  "effective_from" DATE NOT NULL,
  "effective_to" DATE,
  "reason" TEXT NOT NULL DEFAULT '',
  "created_by" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "store_rent_histories_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "store_rent_histories_store_key_fkey" FOREIGN KEY ("store_key") REFERENCES "Store"("key") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "store_rent_histories_range_valid" CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from"),
  CONSTRAINT "store_rent_histories_month_start" CHECK (EXTRACT(DAY FROM "effective_from") = 1 AND ("effective_to" IS NULL OR EXTRACT(DAY FROM "effective_to") = 1)),
  CONSTRAINT "store_rent_histories_fixed_nonnegative" CHECK ("fixed_amount_cents" IS NULL OR "fixed_amount_cents" >= 0),
  CONSTRAINT "store_rent_histories_percentage_valid" CHECK ("percentage_bps" IS NULL OR ("percentage_bps" >= 0 AND "percentage_bps" <= 10000)),
  CONSTRAINT "store_rent_histories_mode_fields" CHECK (
    ("mode" = 'FIXED' AND "fixed_amount_cents" IS NOT NULL AND "percentage_bps" IS NULL AND "percentage_basis" IS NULL)
    OR
    ("mode" IN ('PERCENT', 'FIXED_PLUS_PERCENT', 'MAX_FIXED_PERCENT') AND "percentage_bps" IS NOT NULL AND "percentage_basis" IS NOT NULL
      AND ("mode" = 'PERCENT' OR "fixed_amount_cents" IS NOT NULL))
  )
);
CREATE UNIQUE INDEX "store_rent_histories_store_from_key" ON "store_rent_histories"("store_key", "effective_from");
CREATE INDEX "store_rent_histories_store_range_idx" ON "store_rent_histories"("store_key", "effective_from", "effective_to");
ALTER TABLE "store_rent_histories"
  ADD CONSTRAINT "store_rent_histories_no_overlap"
  EXCLUDE USING gist (
    "store_key" WITH =,
    daterange("effective_from", COALESCE("effective_to", 'infinity'::date), '[)') WITH &&
  );

CREATE TABLE "store_utility_costs" (
  "id" TEXT NOT NULL,
  "store_key" TEXT NOT NULL,
  "period" DATE NOT NULL,
  "estimated_cents" BIGINT NOT NULL,
  "actual_cents" BIGINT,
  "note" TEXT NOT NULL DEFAULT '',
  "created_by" TEXT NOT NULL DEFAULT '',
  "updated_by" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "store_utility_costs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "store_utility_costs_store_key_fkey" FOREIGN KEY ("store_key") REFERENCES "Store"("key") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "store_utility_costs_estimated_nonnegative" CHECK ("estimated_cents" >= 0),
  CONSTRAINT "store_utility_costs_actual_nonnegative" CHECK ("actual_cents" IS NULL OR "actual_cents" >= 0),
  CONSTRAINT "store_utility_costs_month_start" CHECK (EXTRACT(DAY FROM "period") = 1)
);
CREATE UNIQUE INDEX "store_utility_costs_store_period_key" ON "store_utility_costs"("store_key", "period");
CREATE INDEX "store_utility_costs_period_idx" ON "store_utility_costs"("period");

CREATE TABLE "store_labor_cost_periods" (
  "id" TEXT NOT NULL,
  "store_key" TEXT NOT NULL,
  "period" DATE NOT NULL,
  "note" TEXT NOT NULL DEFAULT '',
  "confirmed_at" TIMESTAMP(3) NOT NULL,
  "confirmed_by" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "store_labor_cost_periods_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "store_labor_cost_periods_store_key_fkey" FOREIGN KEY ("store_key") REFERENCES "Store"("key") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "store_labor_cost_periods_month_start" CHECK (EXTRACT(DAY FROM "period") = 1)
);
CREATE UNIQUE INDEX "store_labor_cost_periods_store_period_key" ON "store_labor_cost_periods"("store_key", "period");
CREATE INDEX "store_labor_cost_periods_period_idx" ON "store_labor_cost_periods"("period");

CREATE TABLE "store_labor_cost_entries" (
  "id" TEXT NOT NULL,
  "period_id" TEXT NOT NULL,
  "category" "LaborCostCategory" NOT NULL,
  "amount_cents" BIGINT NOT NULL,
  "employee_id" TEXT,
  "note" TEXT NOT NULL DEFAULT '',
  "created_by" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "store_labor_cost_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "store_labor_cost_entries_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "store_labor_cost_periods"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "store_labor_cost_entries_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "store_labor_cost_entries_amount_nonnegative" CHECK ("amount_cents" >= 0)
);
CREATE INDEX "store_labor_cost_entries_period_category_idx" ON "store_labor_cost_entries"("period_id", "category");
CREATE INDEX "store_labor_cost_entries_employee_idx" ON "store_labor_cost_entries"("employee_id");
