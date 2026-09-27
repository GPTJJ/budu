-- Roll back P7B-M64 to the exact Migration 63 settlement/refund behavior.
-- Fails closed if source-free pure Sweet Card refund rows already exist.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE OR REPLACE FUNCTION public.budu_guard_payment_authority()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.budu_guard_refund_authority()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.budu_guard_settled_order_proof()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.budu_validate_refund_contract(target_refund_id text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
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
$function$;

-- pg_get_functiondef() showed Migration 63 functions inherited search_path.
-- CREATE OR REPLACE may retain proconfig, so reset it explicitly.
ALTER FUNCTION public.budu_guard_refund_authority() SECURITY INVOKER;
ALTER FUNCTION public.budu_guard_refund_authority() RESET ALL;
ALTER FUNCTION public.budu_guard_payment_authority() SECURITY INVOKER;
ALTER FUNCTION public.budu_guard_payment_authority() RESET ALL;
ALTER FUNCTION public.budu_guard_settled_order_proof() SECURITY INVOKER;
ALTER FUNCTION public.budu_guard_settled_order_proof() RESET ALL;
ALTER FUNCTION public.budu_validate_refund_contract(text) SECURITY INVOKER;
ALTER FUNCTION public.budu_validate_refund_contract(text) RESET ALL;

ALTER TABLE public.refunds ADD CONSTRAINT refunds_source_xor_m63
CHECK (
  (payment_id IS NOT NULL AND external_settlement_id IS NULL)
  OR (payment_id IS NULL AND external_settlement_id IS NOT NULL)
) NOT VALID;

ALTER TABLE public.refunds ADD CONSTRAINT refunds_mode_source_contract_m63
CHECK (
  (
    refund_mode = 'PAYMENT'
    AND payment_id IS NOT NULL
    AND external_settlement_id IS NULL
    AND external_completed_at IS NULL
    AND external_refund_reference IS NULL
  )
  OR (
    refund_mode = 'MANUAL_EXTERNAL'
    AND payment_id IS NULL
    AND external_settlement_id IS NOT NULL
    AND status = 'completed'
    AND provider_refund_no IS NULL
    AND completed_at IS NOT NULL
    AND external_completed_at IS NOT NULL
    AND char_length(btrim(requested_by)) > 0
    AND char_length(btrim(approved_by)) > 0
  )
) NOT VALID;

ALTER TABLE public.refunds VALIDATE CONSTRAINT refunds_source_xor_m63;
ALTER TABLE public.refunds VALIDATE CONSTRAINT refunds_mode_source_contract_m63;
ALTER TABLE public.refunds DROP CONSTRAINT refunds_source_xor;
ALTER TABLE public.refunds DROP CONSTRAINT refunds_mode_source_contract;
ALTER TABLE public.refunds RENAME CONSTRAINT refunds_source_xor_m63 TO refunds_source_xor;
ALTER TABLE public.refunds RENAME CONSTRAINT refunds_mode_source_contract_m63 TO refunds_mode_source_contract;

COMMIT;
