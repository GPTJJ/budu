-- RC-2A: introduce explicit order dimensions and an ExternalSettlement authority.
-- This migration is additive. Every pre-existing order remains a STORE_POS / PAYMENT
-- order; no historical amount, status, Payment, Refund, or RefundItem is rewritten.

CREATE TYPE "OrderSource" AS ENUM ('STORE_POS', 'MEITUAN', 'TAOBAO_FLASH', 'JD_INSTANT', 'OTHER');
CREATE TYPE "EntryMode" AS ENUM ('POS_CHECKOUT', 'MANUAL_POS');
CREATE TYPE "SettlementAuthority" AS ENUM ('PAYMENT', 'EXTERNAL');
CREATE TYPE "ExternalSettlementType" AS ENUM ('PLATFORM', 'CUSTOM');
CREATE TYPE "ExternalSettlementStatus" AS ENUM ('PENDING', 'CONFIRMED', 'VOIDED');

ALTER TABLE "orders"
  ADD COLUMN "order_source" "OrderSource" NOT NULL DEFAULT 'STORE_POS',
  ADD COLUMN "entry_mode" "EntryMode" NOT NULL DEFAULT 'POS_CHECKOUT',
  ADD COLUMN "settlement_authority" "SettlementAuthority" NOT NULL DEFAULT 'PAYMENT',
  ADD COLUMN "source_order_ref" TEXT;

-- Explicit and cardinality-independent legacy backfill. Never gate this on an
-- assumed historical order count: production is live and the count may change.
UPDATE "orders"
SET
  "order_source" = 'STORE_POS',
  "entry_mode" = 'POS_CHECKOUT',
  "settlement_authority" = 'PAYMENT',
  "source_order_ref" = NULL;

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_source_entry_authority_mapping"
  CHECK (
    ("order_source" = 'STORE_POS' AND "entry_mode" = 'POS_CHECKOUT' AND "settlement_authority" = 'PAYMENT')
    OR
    ("order_source" IN ('MEITUAN', 'TAOBAO_FLASH', 'JD_INSTANT', 'OTHER') AND "entry_mode" = 'MANUAL_POS' AND "settlement_authority" = 'EXTERNAL')
  );

CREATE INDEX "orders_order_source_business_date_status_idx"
  ON "orders"("order_source", "business_date", "status");
CREATE INDEX "orders_settlement_authority_status_idx"
  ON "orders"("settlement_authority", "status");

CREATE TABLE "external_settlements" (
  "id" TEXT NOT NULL,
  "settlement_no" TEXT NOT NULL,
  "order_id" TEXT NOT NULL,
  "settlement_type" "ExternalSettlementType" NOT NULL,
  "amount_cents" BIGINT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'CNY',
  "status" "ExternalSettlementStatus" NOT NULL DEFAULT 'PENDING',
  "request_key" TEXT NOT NULL,
  "note" TEXT NOT NULL DEFAULT '',
  "recorded_by" TEXT NOT NULL,
  "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "confirmed_by" TEXT NOT NULL DEFAULT '',
  "confirmed_at" TIMESTAMP(3),
  "voided_by" TEXT NOT NULL DEFAULT '',
  "voided_at" TIMESTAMP(3),
  "void_reason" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "external_settlements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "external_settlements_amount_positive" CHECK ("amount_cents" > 0),
  CONSTRAINT "external_settlements_currency_cny" CHECK ("currency" = 'CNY'),
  CONSTRAINT "external_settlements_request_key_length" CHECK (char_length("request_key") BETWEEN 8 AND 160),
  CONSTRAINT "external_settlements_recorded_by_present" CHECK (char_length(btrim("recorded_by")) > 0),
  CONSTRAINT "external_settlements_status_audit_complete" CHECK (
    ("status" = 'PENDING' AND "confirmed_at" IS NULL AND "confirmed_by" = '' AND "voided_at" IS NULL AND "voided_by" = '' AND "void_reason" = '')
    OR
    ("status" = 'CONFIRMED' AND "confirmed_at" IS NOT NULL AND char_length(btrim("confirmed_by")) > 0 AND "voided_at" IS NULL AND "voided_by" = '' AND "void_reason" = '')
    OR
    ("status" = 'VOIDED' AND "confirmed_at" IS NULL AND "confirmed_by" = ''
      AND "voided_at" IS NOT NULL AND char_length(btrim("voided_by")) > 0 AND char_length(btrim("void_reason")) > 0)
  )
);

CREATE UNIQUE INDEX "external_settlements_settlement_no_key" ON "external_settlements"("settlement_no");
CREATE UNIQUE INDEX "external_settlements_order_id_key" ON "external_settlements"("order_id");
CREATE UNIQUE INDEX "external_settlements_request_key_key" ON "external_settlements"("request_key");
CREATE INDEX "external_settlements_status_recorded_at_idx" ON "external_settlements"("status", "recorded_at");

ALTER TABLE "external_settlements"
  ADD CONSTRAINT "external_settlements_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Payment rows can only belong to PAYMENT orders. External settlement facts can
-- never enter merchant-trade, provider-query, callback, cancel, or reconciliation paths.
CREATE FUNCTION "budu_guard_payment_authority"() RETURNS trigger AS $$
DECLARE
  target_order RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT "status", "payment_status" INTO target_order FROM "orders" WHERE "id" = OLD."order_id";
    IF target_order."status" IN ('paid', 'completed', 'partially_refunded', 'refunded')
       OR target_order."payment_status" IN ('paid', 'partially_refunded', 'refunded') THEN
      RAISE EXCEPTION 'cannot remove settlement proof from settled order' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW."order_id" <> OLD."order_id" THEN
    RAISE EXCEPTION 'payment order_id is immutable' USING ERRCODE = '23514';
  END IF;

  SELECT "settlement_authority", "status", "payment_status", "payable_amount"
  INTO target_order
  FROM "orders"
  WHERE "id" = NEW."order_id"
  FOR KEY SHARE;

  IF NOT FOUND OR target_order."settlement_authority" <> 'PAYMENT' THEN
    RAISE EXCEPTION 'payment authority does not match order' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM "external_settlements" WHERE "order_id" = NEW."order_id") THEN
    RAISE EXCEPTION 'payment and external settlement cannot coexist' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND target_order."status" IN ('paid', 'completed', 'partially_refunded', 'refunded') THEN
    RAISE EXCEPTION 'cannot add payment to settled order' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" IN ('success', 'partially_refunded', 'refunded')
     AND NEW."amount" <> target_order."payable_amount" THEN
    RAISE EXCEPTION 'payment amount does not match order payable amount' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD."status" IN ('success', 'partially_refunded', 'refunded')
     AND NEW."status" NOT IN ('success', 'partially_refunded', 'refunded')
     AND (target_order."status" IN ('paid', 'completed', 'partially_refunded', 'refunded')
          OR target_order."payment_status" IN ('paid', 'partially_refunded', 'refunded')) THEN
    RAISE EXCEPTION 'cannot invalidate settlement proof for settled order' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "payments_authority_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "payments"
FOR EACH ROW EXECUTE FUNCTION "budu_guard_payment_authority"();

-- ExternalSettlement is a separate accounting authority. It cannot reference a
-- PAYMENT order, coexist with any Payment row, or carry a client-chosen amount.
CREATE FUNCTION "budu_guard_external_settlement_authority"() RETURNS trigger AS $$
DECLARE
  target_order RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT "status", "payment_status" INTO target_order FROM "orders" WHERE "id" = OLD."order_id";
    IF target_order."status" IN ('paid', 'completed', 'partially_refunded', 'refunded')
       OR target_order."payment_status" IN ('paid', 'partially_refunded', 'refunded') THEN
      RAISE EXCEPTION 'cannot remove settlement proof from settled order' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW."order_id" <> OLD."order_id" THEN
    RAISE EXCEPTION 'external settlement order_id is immutable' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' AND (
       NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."settlement_no" IS DISTINCT FROM OLD."settlement_no"
       OR NEW."order_id" IS DISTINCT FROM OLD."order_id"
       OR NEW."settlement_type" IS DISTINCT FROM OLD."settlement_type"
       OR NEW."amount_cents" IS DISTINCT FROM OLD."amount_cents"
       OR NEW."currency" IS DISTINCT FROM OLD."currency"
       OR NEW."request_key" IS DISTINCT FROM OLD."request_key"
       OR NEW."recorded_by" IS DISTINCT FROM OLD."recorded_by"
       OR NEW."recorded_at" IS DISTINCT FROM OLD."recorded_at"
     ) THEN
    RAISE EXCEPTION 'external settlement identity and amount are immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'CONFIRMED' AND (
       NEW."status" <> 'CONFIRMED'
       OR NEW."confirmed_by" IS DISTINCT FROM OLD."confirmed_by"
       OR NEW."confirmed_at" IS DISTINCT FROM OLD."confirmed_at"
     ) THEN
    RAISE EXCEPTION 'confirmed external settlement is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'VOIDED' AND NEW."status" <> 'VOIDED' THEN
    RAISE EXCEPTION 'voided external settlement is immutable' USING ERRCODE = '23514';
  END IF;

  SELECT "order_source", "settlement_authority", "status", "payment_status", "payable_amount"
  INTO target_order
  FROM "orders"
  WHERE "id" = NEW."order_id"
  FOR KEY SHARE;

  IF NOT FOUND OR target_order."settlement_authority" <> 'EXTERNAL' THEN
    RAISE EXCEPTION 'external settlement authority does not match order' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM "payments" WHERE "order_id" = NEW."order_id") THEN
    RAISE EXCEPTION 'payment and external settlement cannot coexist' USING ERRCODE = '23514';
  END IF;
  IF NEW."amount_cents" <> target_order."payable_amount" THEN
    RAISE EXCEPTION 'external settlement amount does not match order payable amount' USING ERRCODE = '23514';
  END IF;
  IF (target_order."order_source" = 'OTHER' AND NEW."settlement_type" <> 'CUSTOM')
     OR (target_order."order_source" IN ('MEITUAN', 'TAOBAO_FLASH', 'JD_INSTANT') AND NEW."settlement_type" <> 'PLATFORM') THEN
    RAISE EXCEPTION 'external settlement type does not match order source' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD."status" = 'CONFIRMED'
     AND NEW."status" <> 'CONFIRMED'
     AND (target_order."status" IN ('paid', 'completed', 'partially_refunded', 'refunded')
          OR target_order."payment_status" IN ('paid', 'partially_refunded', 'refunded')) THEN
    RAISE EXCEPTION 'cannot invalidate settlement proof for settled order' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "external_settlements_authority_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "external_settlements"
FOR EACH ROW EXECUTE FUNCTION "budu_guard_external_settlement_authority"();

-- Any persisted settled order must be derivable from exactly one authority and
-- an amount-matching fact. This fires after the proof row has reached its terminal state.
CREATE FUNCTION "budu_guard_settled_order_proof"() RETURNS trigger AS $$
DECLARE
  payment_proofs INTEGER;
  external_proofs INTEGER;
  any_payments INTEGER;
  any_external INTEGER;
BEGIN
  SELECT COUNT(*)::INTEGER,
         COUNT(*) FILTER (
           WHERE "status" IN ('success', 'partially_refunded', 'refunded')
             AND "amount" = NEW."payable_amount"
         )::INTEGER
  INTO any_payments, payment_proofs
  FROM "payments"
  WHERE "order_id" = NEW."id";

  SELECT COUNT(*)::INTEGER,
         COUNT(*) FILTER (
           WHERE "status" = 'CONFIRMED'
             AND "amount_cents" = NEW."payable_amount"
         )::INTEGER
  INTO any_external, external_proofs
  FROM "external_settlements"
  WHERE "order_id" = NEW."id";

  IF NEW."settlement_authority" = 'PAYMENT' AND any_external <> 0 THEN
    RAISE EXCEPTION 'PAYMENT order cannot have ExternalSettlement' USING ERRCODE = '23514';
  END IF;
  IF NEW."settlement_authority" = 'EXTERNAL' AND any_payments <> 0 THEN
    RAISE EXCEPTION 'EXTERNAL order cannot have Payment' USING ERRCODE = '23514';
  END IF;

  IF NEW."status" IN ('paid', 'completed', 'partially_refunded', 'refunded')
     OR NEW."payment_status" IN ('paid', 'partially_refunded', 'refunded') THEN
    IF NEW."settlement_authority" = 'PAYMENT' AND NOT (payment_proofs = 1 AND external_proofs = 0) THEN
      RAISE EXCEPTION 'settled PAYMENT order requires exactly one valid Payment proof' USING ERRCODE = '23514';
    END IF;
    IF NEW."settlement_authority" = 'EXTERNAL' AND NOT (external_proofs = 1 AND payment_proofs = 0) THEN
      RAISE EXCEPTION 'settled EXTERNAL order requires exactly one valid ExternalSettlement proof' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "orders_settled_proof_guard"
BEFORE INSERT OR UPDATE ON "orders"
FOR EACH ROW EXECUTE FUNCTION "budu_guard_settled_order_proof"();

-- Cross-row existence cannot be expressed by a CHECK. Enforce it at transaction
-- commit so an EXTERNAL order and its one settlement can be inserted atomically.
CREATE FUNCTION "budu_require_external_settlement"() RETURNS trigger AS $$
DECLARE
  settlement_count INTEGER;
BEGIN
  IF NEW."settlement_authority" = 'EXTERNAL' THEN
    SELECT COUNT(*)::INTEGER INTO settlement_count
    FROM "external_settlements"
    WHERE "order_id" = NEW."id";
    IF settlement_count <> 1 THEN
      RAISE EXCEPTION 'EXTERNAL order requires exactly one ExternalSettlement' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "orders_external_settlement_required"
AFTER INSERT OR UPDATE OF "settlement_authority" ON "orders"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "budu_require_external_settlement"();
