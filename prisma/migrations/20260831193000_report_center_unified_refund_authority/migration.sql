-- RC-2B: one Refund/RefundItem authority for both Payment refunds and manual
-- ExternalSettlement refund facts. Historical financial facts are preserved.

-- Rebuild instead of ALTER TYPE ADD VALUE so the new labels are safe to use
-- later in this same atomic Prisma migration transaction.
ALTER TABLE "external_settlements" DROP CONSTRAINT "external_settlements_status_audit_complete";
ALTER TABLE "external_settlements" ALTER COLUMN "status" DROP DEFAULT;
ALTER TYPE "ExternalSettlementStatus" RENAME TO "ExternalSettlementStatus_rc2a";
CREATE TYPE "ExternalSettlementStatus" AS ENUM ('PENDING', 'CONFIRMED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'VOIDED');
ALTER TABLE "external_settlements" ALTER COLUMN "status" TYPE "ExternalSettlementStatus"
  USING ("status"::TEXT::"ExternalSettlementStatus");
ALTER TABLE "external_settlements" ALTER COLUMN "status" SET DEFAULT 'PENDING';
DROP TYPE "ExternalSettlementStatus_rc2a";
CREATE TYPE "RefundMode" AS ENUM ('PAYMENT', 'MANUAL_EXTERNAL');

ALTER TABLE "refunds"
  ALTER COLUMN "payment_id" DROP NOT NULL,
  ADD COLUMN "external_settlement_id" TEXT,
  ADD COLUMN "refund_mode" "RefundMode" NOT NULL DEFAULT 'PAYMENT',
  ADD COLUMN "external_completed_at" TIMESTAMP(3),
  ADD COLUMN "external_refund_reference" TEXT;

UPDATE "refunds"
SET "refund_mode" = 'PAYMENT',
    "external_settlement_id" = NULL,
    "external_completed_at" = NULL,
    "external_refund_reference" = NULL;

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_external_settlement_id_fkey"
  FOREIGN KEY ("external_settlement_id") REFERENCES "external_settlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "refunds_source_xor"
  CHECK (
    ("payment_id" IS NOT NULL AND "external_settlement_id" IS NULL)
    OR ("payment_id" IS NULL AND "external_settlement_id" IS NOT NULL)
  ),
  ADD CONSTRAINT "refunds_mode_source_contract"
  CHECK (
    ("refund_mode" = 'PAYMENT'
      AND "payment_id" IS NOT NULL
      AND "external_settlement_id" IS NULL
      AND "external_completed_at" IS NULL
      AND "external_refund_reference" IS NULL)
    OR
    ("refund_mode" = 'MANUAL_EXTERNAL'
      AND "payment_id" IS NULL
      AND "external_settlement_id" IS NOT NULL
      AND "status" = 'completed'
      AND "provider_refund_no" IS NULL
      AND "completed_at" IS NOT NULL
      AND "external_completed_at" IS NOT NULL
      AND char_length(btrim("requested_by")) > 0
      AND char_length(btrim("approved_by")) > 0)
  ),
  ADD CONSTRAINT "refunds_amount_positive" CHECK ("refund_amount" > 0),
  ADD CONSTRAINT "refunds_external_reference_length"
  CHECK ("external_refund_reference" IS NULL OR char_length("external_refund_reference") <= 160);

CREATE INDEX "refunds_external_settlement_id_created_at_idx"
  ON "refunds"("external_settlement_id", "created_at");
CREATE INDEX "refunds_refund_mode_status_created_at_idx"
  ON "refunds"("refund_mode", "status", "created_at");
CREATE UNIQUE INDEX "refund_items_refund_id_order_item_id_key"
  ON "refund_items"("refund_id", "order_item_id");

ALTER TABLE "refund_items" DROP CONSTRAINT "refund_items_amount_positive";
ALTER TABLE "refund_items"
  ADD CONSTRAINT "refund_items_amount_nonnegative" CHECK ("amount_cents" >= 0);

ALTER TABLE "external_settlements"
  ADD CONSTRAINT "external_settlements_status_audit_complete" CHECK (
    ("status" = 'PENDING' AND "confirmed_at" IS NULL AND "confirmed_by" = '' AND "voided_at" IS NULL AND "voided_by" = '' AND "void_reason" = '')
    OR
    ("status" IN ('CONFIRMED', 'PARTIALLY_REFUNDED', 'REFUNDED')
      AND "confirmed_at" IS NOT NULL AND char_length(btrim("confirmed_by")) > 0
      AND "voided_at" IS NULL AND "voided_by" = '' AND "void_reason" = '')
    OR
    ("status" = 'VOIDED' AND "confirmed_at" IS NULL AND "confirmed_by" = ''
      AND "voided_at" IS NOT NULL AND char_length(btrim("voided_by")) > 0 AND char_length(btrim("void_reason")) > 0)
  );

-- Source identity and cross-order bindings are immutable and fail closed.
CREATE FUNCTION "budu_guard_refund_authority"() RETURNS trigger AS $$
DECLARE
  target_order RECORD;
  source_order_id TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'refund financial facts cannot be deleted' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' AND (
       NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."refund_no" IS DISTINCT FROM OLD."refund_no"
       OR NEW."order_id" IS DISTINCT FROM OLD."order_id"
       OR NEW."payment_id" IS DISTINCT FROM OLD."payment_id"
       OR NEW."external_settlement_id" IS DISTINCT FROM OLD."external_settlement_id"
       OR NEW."refund_mode" IS DISTINCT FROM OLD."refund_mode"
       OR NEW."refund_amount" IS DISTINCT FROM OLD."refund_amount"
       OR NEW."request_key" IS DISTINCT FROM OLD."request_key"
       OR NEW."requested_by" IS DISTINCT FROM OLD."requested_by"
       OR NEW."approved_by" IS DISTINCT FROM OLD."approved_by"
       OR NEW."external_completed_at" IS DISTINCT FROM OLD."external_completed_at"
       OR NEW."external_refund_reference" IS DISTINCT FROM OLD."external_refund_reference"
     ) THEN
    RAISE EXCEPTION 'refund source, amount, identity, and audit fields are immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" IN ('completed', 'failed') AND NEW."status" <> OLD."status" THEN
    RAISE EXCEPTION 'terminal refund status is immutable' USING ERRCODE = '23514';
  END IF;

  SELECT "settlement_authority" INTO target_order FROM "orders" WHERE "id" = NEW."order_id" FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'refund order does not exist' USING ERRCODE = '23503';
  END IF;

  IF NEW."refund_mode" = 'PAYMENT' THEN
    IF NEW."payment_id" IS NULL OR NEW."external_settlement_id" IS NOT NULL OR target_order."settlement_authority" <> 'PAYMENT' THEN
      RAISE EXCEPTION 'PAYMENT refund authority mismatch' USING ERRCODE = '23514';
    END IF;
    SELECT "order_id" INTO source_order_id FROM "payments" WHERE "id" = NEW."payment_id" FOR KEY SHARE;
  ELSE
    IF NEW."payment_id" IS NOT NULL OR NEW."external_settlement_id" IS NULL OR target_order."settlement_authority" <> 'EXTERNAL' THEN
      RAISE EXCEPTION 'MANUAL_EXTERNAL refund authority mismatch' USING ERRCODE = '23514';
    END IF;
    SELECT "order_id" INTO source_order_id FROM "external_settlements"
    WHERE "id" = NEW."external_settlement_id" AND "status" IN ('CONFIRMED', 'PARTIALLY_REFUNDED', 'REFUNDED')
    FOR KEY SHARE;
  END IF;
  IF source_order_id IS NULL OR source_order_id <> NEW."order_id" THEN
    RAISE EXCEPTION 'refund source and order mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "refunds_authority_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "refunds"
FOR EACH ROW EXECUTE FUNCTION "budu_guard_refund_authority"();

-- RefundItem must belong to the Refund order. Pending PAYMENT items reserve
-- quantity and amount; failed refunds release that reservation.
CREATE FUNCTION "budu_guard_refund_item_authority"() RETURNS trigger AS $$
DECLARE
  refund_row RECORD;
  order_item_row RECORD;
  used_quantity BIGINT;
  used_amount BIGINT;
  item_amount BIGINT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'refund item facts cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'refund item facts are immutable' USING ERRCODE = '23514';
  END IF;

  SELECT "order_id", "status" INTO refund_row FROM "refunds" WHERE "id" = NEW."refund_id" FOR KEY SHARE;
  IF NOT FOUND OR refund_row."status" NOT IN ('pending', 'completed') THEN
    RAISE EXCEPTION 'refund item requires an active refund' USING ERRCODE = '23514';
  END IF;
  SELECT "order_id", "quantity", "actual_amount", "line_amount", "discount_amount"
  INTO order_item_row FROM "order_items" WHERE "id" = NEW."order_item_id" FOR UPDATE;
  IF NOT FOUND OR order_item_row."order_id" <> refund_row."order_id" THEN
    RAISE EXCEPTION 'refund item and refund order mismatch' USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(ri."quantity"), 0), COALESCE(SUM(ri."amount_cents"), 0)
  INTO used_quantity, used_amount
  FROM "refund_items" ri
  JOIN "refunds" r ON r."id" = ri."refund_id"
  WHERE ri."order_item_id" = NEW."order_item_id" AND r."status" IN ('pending', 'completed');

  item_amount := CASE WHEN order_item_row."actual_amount" > 0
    THEN order_item_row."actual_amount"
    ELSE GREATEST(order_item_row."line_amount" - order_item_row."discount_amount", 0)
  END;
  IF used_quantity + NEW."quantity" > order_item_row."quantity" THEN
    RAISE EXCEPTION 'refund item quantity exceeds order item quantity' USING ERRCODE = '23514';
  END IF;
  IF used_amount + NEW."amount_cents" > item_amount THEN
    RAISE EXCEPTION 'refund item amount exceeds order item refundable amount' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "refund_items_authority_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "refund_items"
FOR EACH ROW EXECUTE FUNCTION "budu_guard_refund_item_authority"();

-- External settlement status becomes refund-derived while identity and audit
-- fields remain immutable.
CREATE OR REPLACE FUNCTION "budu_guard_external_settlement_authority"() RETURNS trigger AS $$
DECLARE
  target_order RECORD;
  completed_refund BIGINT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT "status", "payment_status" INTO target_order FROM "orders" WHERE "id" = OLD."order_id";
    IF target_order."status" IN ('paid', 'completed', 'partially_refunded', 'refunded')
       OR target_order."payment_status" IN ('paid', 'partially_refunded', 'refunded') THEN
      RAISE EXCEPTION 'cannot remove settlement proof from settled order' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
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
    RAISE EXCEPTION 'external settlement identity, amount, and confirmation audit are immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" IN ('CONFIRMED', 'PARTIALLY_REFUNDED', 'REFUNDED')
     AND (NEW."confirmed_by" IS DISTINCT FROM OLD."confirmed_by"
          OR NEW."confirmed_at" IS DISTINCT FROM OLD."confirmed_at") THEN
    RAISE EXCEPTION 'external settlement confirmation audit is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'VOIDED'
     AND (NEW."voided_by" IS DISTINCT FROM OLD."voided_by"
          OR NEW."voided_at" IS DISTINCT FROM OLD."voided_at"
          OR NEW."void_reason" IS DISTINCT FROM OLD."void_reason") THEN
    RAISE EXCEPTION 'external settlement void audit is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NOT (
       (OLD."status" = 'PENDING' AND NEW."status" IN ('PENDING', 'CONFIRMED', 'VOIDED'))
       OR (OLD."status" = 'CONFIRMED' AND NEW."status" IN ('CONFIRMED', 'PARTIALLY_REFUNDED', 'REFUNDED'))
       OR (OLD."status" = 'PARTIALLY_REFUNDED' AND NEW."status" IN ('PARTIALLY_REFUNDED', 'REFUNDED'))
       OR (OLD."status" = 'REFUNDED' AND NEW."status" = 'REFUNDED')
       OR (OLD."status" = 'VOIDED' AND NEW."status" = 'VOIDED')
     ) THEN
    RAISE EXCEPTION 'external settlement status transition is invalid' USING ERRCODE = '23514';
  END IF;

  SELECT "order_source", "settlement_authority", "status", "payment_status", "payable_amount"
  INTO target_order FROM "orders" WHERE "id" = NEW."order_id" FOR KEY SHARE;
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

  IF NEW."status" IN ('PARTIALLY_REFUNDED', 'REFUNDED') THEN
    SELECT COALESCE(SUM("refund_amount"), 0) INTO completed_refund
    FROM "refunds" WHERE "external_settlement_id" = NEW."id"
      AND "refund_mode" = 'MANUAL_EXTERNAL' AND "status" = 'completed';
    IF (NEW."status" = 'PARTIALLY_REFUNDED' AND NOT (completed_refund > 0 AND completed_refund < NEW."amount_cents"))
       OR (NEW."status" = 'REFUNDED' AND completed_refund <> NEW."amount_cents") THEN
      RAISE EXCEPTION 'external settlement refund status does not match completed refunds' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "budu_guard_settled_order_proof"() RETURNS trigger AS $$
DECLARE
  payment_proofs INTEGER;
  external_proofs INTEGER;
  any_payments INTEGER;
  any_external INTEGER;
BEGIN
  SELECT COUNT(*)::INTEGER,
         COUNT(*) FILTER (WHERE "status" IN ('success', 'partially_refunded', 'refunded') AND "amount" = NEW."payable_amount")::INTEGER
  INTO any_payments, payment_proofs FROM "payments" WHERE "order_id" = NEW."id";
  SELECT COUNT(*)::INTEGER,
         COUNT(*) FILTER (WHERE "status" IN ('CONFIRMED', 'PARTIALLY_REFUNDED', 'REFUNDED') AND "amount_cents" = NEW."payable_amount")::INTEGER
  INTO any_external, external_proofs FROM "external_settlements" WHERE "order_id" = NEW."id";
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

-- Deferred reconciliation sees the final state of Refund, RefundItem, Order and
-- its settlement source after the application transaction completes.
CREATE FUNCTION "budu_validate_refund_contract"(target_refund_id TEXT) RETURNS VOID AS $$
DECLARE
  r RECORD;
  o RECORD;
  item_count INTEGER;
  item_amount BIGINT;
  completed_total BIGINT;
  expected_status TEXT;
  source_status TEXT;
BEGIN
  SELECT * INTO r FROM "refunds" WHERE "id" = target_refund_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT COUNT(*)::INTEGER, COALESCE(SUM("amount_cents"), 0)
  INTO item_count, item_amount FROM "refund_items" WHERE "refund_id" = r."id";
  IF item_count = 0 OR item_amount <> r."refund_amount" THEN
    RAISE EXCEPTION 'refund item allocation must exactly equal refund amount' USING ERRCODE = '23514';
  END IF;
  IF r."status" <> 'completed' THEN RETURN; END IF;

  SELECT * INTO o FROM "orders" WHERE "id" = r."order_id";
  SELECT COALESCE(SUM("refund_amount"), 0) INTO completed_total
  FROM "refunds" WHERE "order_id" = r."order_id" AND "status" = 'completed';
  IF completed_total <= 0 OR completed_total > o."payable_amount" THEN
    RAISE EXCEPTION 'completed refund total exceeds settled order amount' USING ERRCODE = '23514';
  END IF;
  expected_status := CASE WHEN completed_total = o."payable_amount" THEN 'refunded' ELSE 'partially_refunded' END;
  IF o."status" <> expected_status OR o."payment_status" <> expected_status THEN
    RAISE EXCEPTION 'order refund state does not match completed refund total' USING ERRCODE = '23514';
  END IF;
  IF r."refund_mode" = 'PAYMENT' THEN
    SELECT "status" INTO source_status FROM "payments" WHERE "id" = r."payment_id";
    IF source_status <> expected_status THEN
      RAISE EXCEPTION 'payment refund state does not match completed refund total' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT "status"::TEXT INTO source_status FROM "external_settlements" WHERE "id" = r."external_settlement_id";
    IF source_status <> (CASE WHEN expected_status = 'refunded' THEN 'REFUNDED' ELSE 'PARTIALLY_REFUNDED' END) THEN
      RAISE EXCEPTION 'external settlement state does not match completed refund total' USING ERRCODE = '23514';
    END IF;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION "budu_refund_contract_trigger"() RETURNS trigger AS $$
BEGIN
  PERFORM "budu_validate_refund_contract"(CASE WHEN TG_OP = 'DELETE' THEN OLD."id" ELSE NEW."id" END);
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION "budu_refund_item_contract_trigger"() RETURNS trigger AS $$
BEGIN
  PERFORM "budu_validate_refund_contract"(CASE WHEN TG_OP = 'DELETE' THEN OLD."refund_id" ELSE NEW."refund_id" END);
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "refunds_contract_deferred"
AFTER INSERT OR UPDATE OR DELETE ON "refunds"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "budu_refund_contract_trigger"();

CREATE CONSTRAINT TRIGGER "refund_items_contract_deferred"
AFTER INSERT OR UPDATE OR DELETE ON "refund_items"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "budu_refund_item_contract_trigger"();
