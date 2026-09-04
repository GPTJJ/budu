-- P7B-M64: make Order settlement and Refund validation aware of the existing
-- Sweet Card internal-settlement authority. No table/column/type or business
-- row is created, removed, rewritten, or backfilled.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE OR REPLACE FUNCTION "public"."budu_guard_payment_authority"() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  target_order RECORD;
  redemption_count INTEGER;
  v_redemption_id TEXT;
  v_redemption_account_id TEXT;
  v_redemption_amount BIGINT;
  v_redemption_eligible_amount BIGINT;
  redeem_ledger_count INTEGER;
  reversal_ledger_count INTEGER;
  allocation_count INTEGER;
  allocation_amount BIGINT;
  invalid_allocation_count INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT o."status", o."payment_status"
    INTO target_order
    FROM "public"."orders" o
    WHERE o."id" = OLD."order_id";
    IF target_order."status" IN ('paid', 'completed', 'partially_refunded', 'refunded')
       OR target_order."payment_status" IN ('paid', 'partially_refunded', 'refunded') THEN
      RAISE EXCEPTION 'cannot remove settlement proof from settled order' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW."order_id" <> OLD."order_id" THEN
    RAISE EXCEPTION 'payment order_id is immutable' USING ERRCODE = '23514';
  END IF;

  SELECT o."settlement_authority", o."status", o."payment_status",
         o."payable_amount", o."sweet_card_amount"
  INTO target_order
  FROM "public"."orders" o
  WHERE o."id" = NEW."order_id"
  FOR KEY SHARE;

  IF NOT FOUND OR target_order."settlement_authority" <> 'PAYMENT' THEN
    RAISE EXCEPTION 'payment authority does not match order' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "public"."external_settlements" es
    WHERE es."order_id" = NEW."order_id"
  ) THEN
    RAISE EXCEPTION 'payment and external settlement cannot coexist' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND target_order."status" IN ('paid', 'completed', 'partially_refunded', 'refunded') THEN
    RAISE EXCEPTION 'cannot add payment to settled order' USING ERRCODE = '23514';
  END IF;

  IF NEW."status" IN ('success', 'partially_refunded', 'refunded') THEN
    IF target_order."sweet_card_amount" = 0 THEN
      IF NEW."amount" <> target_order."payable_amount" THEN
        RAISE EXCEPTION 'payment amount does not match order payable amount' USING ERRCODE = '23514';
      END IF;
    ELSE
      SELECT COUNT(*)::INTEGER, MIN(sr."id"), MIN(sr."account_id"),
             COALESCE(SUM(sr."amount_cents"), 0)::BIGINT,
             COALESCE(SUM(sr."eligible_subtotal_cents"), 0)::BIGINT
      INTO redemption_count, v_redemption_id, v_redemption_account_id,
           v_redemption_amount, v_redemption_eligible_amount
      FROM "public"."sweet_card_redemptions" sr
      WHERE sr."order_id" = NEW."order_id";

      SELECT COUNT(*) FILTER (
               WHERE sl."type" = 'REDEEM'
                 AND sl."amount_cents" = -v_redemption_amount
             )::INTEGER,
             COUNT(*) FILTER (WHERE sl."type" = 'REVERSAL')::INTEGER
      INTO redeem_ledger_count, reversal_ledger_count
      FROM "public"."sweet_card_ledger" sl
      WHERE sl."order_id" = NEW."order_id"
        AND sl."redemption_id" = v_redemption_id
        AND sl."account_id" = v_redemption_account_id
        AND sl."type" IN ('REDEEM', 'REVERSAL');

      SELECT COUNT(*)::INTEGER,
             COALESCE(SUM(sri."redeemed_amount_cents"), 0)::BIGINT,
             COUNT(*) FILTER (
               WHERE sri."redeemed_amount_cents" < 0
                  OR sri."redeemed_amount_cents" > sri."eligible_amount_cents"
                  OR (sri."redeemed_amount_cents" > 0 AND sri."eligible_snapshot" IS NOT TRUE)
                  OR oi."order_id" <> NEW."order_id"
                  OR oi."product_id" <> sri."product_id"
                  OR oi."sweet_card_eligible_snapshot" IS DISTINCT FROM sri."eligible_snapshot"
                  OR oi."sweet_card_redeemed_amount" <> sri."redeemed_amount_cents"
             )::INTEGER
      INTO allocation_count, allocation_amount, invalid_allocation_count
      FROM "public"."sweet_card_redemption_items" sri
      JOIN "public"."order_items" oi ON oi."id" = sri."order_item_id"
      WHERE sri."redemption_id" = v_redemption_id;

      IF redemption_count <> 1
         OR v_redemption_amount <= 0
         OR v_redemption_amount > v_redemption_eligible_amount
         OR v_redemption_amount <> target_order."sweet_card_amount"
         OR redeem_ledger_count <> 1
         OR reversal_ledger_count <> 0
         OR allocation_count = 0
         OR allocation_amount <> v_redemption_amount
         OR invalid_allocation_count <> 0 THEN
        RAISE EXCEPTION 'Payment remainder lacks committed Sweet Card settlement proof' USING ERRCODE = '23514';
      END IF;
      IF target_order."payable_amount" - v_redemption_amount <= 0
         OR NEW."amount" <> target_order."payable_amount" - v_redemption_amount THEN
        RAISE EXCEPTION 'payment amount does not match settlement remainder' USING ERRCODE = '23514';
      END IF;
    END IF;
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

CREATE OR REPLACE FUNCTION "public"."budu_guard_settled_order_proof"() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  any_payments INTEGER;
  valid_payment_proofs INTEGER;
  valid_payment_amount BIGINT;
  any_external INTEGER;
  external_proofs INTEGER;
  redemption_count INTEGER;
  v_redemption_id TEXT;
  v_redemption_account_id TEXT;
  v_redemption_amount BIGINT;
  v_redemption_eligible_amount BIGINT;
  redeem_ledger_count INTEGER;
  matching_redeem_ledger_count INTEGER;
  reversal_ledger_count INTEGER;
  allocation_count INTEGER;
  allocation_amount BIGINT;
  invalid_allocation_count INTEGER;
  sweet_card_proof_valid BOOLEAN := false;
  required_payment_amount BIGINT;
BEGIN
  SELECT COUNT(*)::INTEGER,
         COUNT(*) FILTER (WHERE p."status" IN ('success', 'partially_refunded', 'refunded'))::INTEGER,
         COALESCE(SUM(p."amount") FILTER (WHERE p."status" IN ('success', 'partially_refunded', 'refunded')), 0)::BIGINT
  INTO any_payments, valid_payment_proofs, valid_payment_amount
  FROM "public"."payments" p
  WHERE p."order_id" = NEW."id";

  SELECT COUNT(*)::INTEGER,
         COUNT(*) FILTER (
           WHERE es."status" IN ('CONFIRMED', 'PARTIALLY_REFUNDED', 'REFUNDED')
             AND es."amount_cents" = NEW."payable_amount"
         )::INTEGER
  INTO any_external, external_proofs
  FROM "public"."external_settlements" es
  WHERE es."order_id" = NEW."id";

  SELECT COUNT(*)::INTEGER, MIN(sr."id"), MIN(sr."account_id"),
         COALESCE(SUM(sr."amount_cents"), 0)::BIGINT,
         COALESCE(SUM(sr."eligible_subtotal_cents"), 0)::BIGINT
  INTO redemption_count, v_redemption_id, v_redemption_account_id,
       v_redemption_amount, v_redemption_eligible_amount
  FROM "public"."sweet_card_redemptions" sr
  WHERE sr."order_id" = NEW."id";

  IF redemption_count = 1 THEN
    SELECT COUNT(*) FILTER (WHERE sl."type" = 'REDEEM')::INTEGER,
           COUNT(*) FILTER (
             WHERE sl."type" = 'REDEEM'
               AND sl."redemption_id" = v_redemption_id
               AND sl."account_id" = v_redemption_account_id
               AND sl."amount_cents" = -v_redemption_amount
           )::INTEGER,
           COUNT(*) FILTER (WHERE sl."type" = 'REVERSAL')::INTEGER
    INTO redeem_ledger_count, matching_redeem_ledger_count, reversal_ledger_count
    FROM "public"."sweet_card_ledger" sl
    WHERE sl."order_id" = NEW."id";

    SELECT COUNT(*)::INTEGER,
           COALESCE(SUM(sri."redeemed_amount_cents"), 0)::BIGINT,
           COUNT(*) FILTER (
             WHERE sri."redeemed_amount_cents" < 0
                OR sri."redeemed_amount_cents" > sri."eligible_amount_cents"
                OR (sri."redeemed_amount_cents" > 0 AND sri."eligible_snapshot" IS NOT TRUE)
                OR oi."order_id" <> NEW."id"
                OR oi."product_id" <> sri."product_id"
                OR oi."sweet_card_eligible_snapshot" IS DISTINCT FROM sri."eligible_snapshot"
                OR oi."sweet_card_redeemed_amount" <> sri."redeemed_amount_cents"
           )::INTEGER
    INTO allocation_count, allocation_amount, invalid_allocation_count
    FROM "public"."sweet_card_redemption_items" sri
    JOIN "public"."order_items" oi ON oi."id" = sri."order_item_id"
    WHERE sri."redemption_id" = v_redemption_id;

    sweet_card_proof_valid := v_redemption_amount > 0
      AND v_redemption_amount <= v_redemption_eligible_amount
      AND NEW."sweet_card_amount" = v_redemption_amount
      AND redeem_ledger_count = 1
      AND matching_redeem_ledger_count = 1
      AND reversal_ledger_count = 0
      AND allocation_count > 0
      AND allocation_amount = v_redemption_amount
      AND invalid_allocation_count = 0;
  END IF;

  IF NEW."settlement_authority" = 'PAYMENT' AND any_external <> 0 THEN
    RAISE EXCEPTION 'PAYMENT order cannot have ExternalSettlement' USING ERRCODE = '23514';
  END IF;
  IF NEW."settlement_authority" = 'EXTERNAL' AND any_payments <> 0 THEN
    RAISE EXCEPTION 'EXTERNAL order cannot have Payment' USING ERRCODE = '23514';
  END IF;

  IF NEW."status" IN ('paid', 'completed', 'partially_refunded', 'refunded')
     OR NEW."payment_status" IN ('paid', 'partially_refunded', 'refunded') THEN
    IF NEW."settlement_authority" = 'PAYMENT' THEN
      IF redemption_count = 0 THEN
        IF NEW."sweet_card_amount" <> 0 THEN
          RAISE EXCEPTION 'Sweet Card settlement amount lacks committed redemption proof' USING ERRCODE = '23514';
        END IF;
        v_redemption_amount := 0;
      ELSIF redemption_count <> 1 OR NOT sweet_card_proof_valid THEN
        RAISE EXCEPTION 'Sweet Card settlement proof is incomplete or invalid' USING ERRCODE = '23514';
      END IF;

      required_payment_amount := NEW."payable_amount" - v_redemption_amount;
      IF required_payment_amount < 0 THEN
        RAISE EXCEPTION 'settlement coverage exceeds order payable amount' USING ERRCODE = '23514';
      END IF;
      IF required_payment_amount = 0 THEN
        IF any_payments <> 0 THEN
          RAISE EXCEPTION 'pure Sweet Card settlement cannot have Payment rows' USING ERRCODE = '23514';
        END IF;
      ELSIF valid_payment_proofs <> 1 OR valid_payment_amount <> required_payment_amount THEN
        RAISE EXCEPTION 'settled PAYMENT order requires exact Payment remainder coverage' USING ERRCODE = '23514';
      END IF;
    ELSIF NEW."settlement_authority" = 'EXTERNAL' THEN
      IF redemption_count <> 0 OR NEW."sweet_card_amount" <> 0 THEN
        RAISE EXCEPTION 'EXTERNAL order cannot have Sweet Card settlement' USING ERRCODE = '23514';
      END IF;
      IF external_proofs <> 1 THEN
        RAISE EXCEPTION 'settled EXTERNAL order requires exactly one valid ExternalSettlement proof' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION "public"."budu_guard_refund_authority"() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  target_order RECORD;
  source_order_id TEXT;
  redemption RECORD;
  redemption_amount BIGINT := 0;
  redeem_ledger_count INTEGER;
  reversal_ledger_count INTEGER;
  allocation_count INTEGER;
  allocation_amount BIGINT;
  invalid_allocation_count INTEGER;
  reserved_provider BIGINT;
  reserved_sweet BIGINT;
  payment_amount BIGINT;
  split_present BOOLEAN;
  pure_sweet_shape BOOLEAN;
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
  IF TG_OP = 'UPDATE' AND OLD."status" IN ('completed', 'failed') AND (
       NEW."provider_refund_amount" IS DISTINCT FROM OLD."provider_refund_amount"
       OR NEW."sweet_card_refund_amount" IS DISTINCT FROM OLD."sweet_card_refund_amount"
     ) THEN
    RAISE EXCEPTION 'terminal refund rail allocation is immutable' USING ERRCODE = '23514';
  END IF;

  SELECT o."settlement_authority", o."payable_amount", o."sweet_card_amount"
  INTO target_order
  FROM "public"."orders" o
  WHERE o."id" = NEW."order_id"
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'refund order does not exist' USING ERRCODE = '23503';
  END IF;

  split_present := NEW."provider_refund_amount" IS NOT NULL OR NEW."sweet_card_refund_amount" IS NOT NULL;
  IF split_present AND (
       NEW."provider_refund_amount" IS NULL
       OR NEW."sweet_card_refund_amount" IS NULL
       OR NEW."provider_refund_amount" < 0
       OR NEW."sweet_card_refund_amount" < 0
       OR NEW."provider_refund_amount" + NEW."sweet_card_refund_amount" <> NEW."refund_amount"
     ) THEN
    RAISE EXCEPTION 'refund rail allocation must exactly equal refund amount' USING ERRCODE = '23514';
  END IF;
  pure_sweet_shape := COALESCE(NEW."refund_mode" = 'PAYMENT'
    AND NEW."payment_id" IS NULL
    AND NEW."external_settlement_id" IS NULL
    AND NEW."provider_refund_amount" = 0
    AND NEW."sweet_card_refund_amount" > 0
    AND NEW."provider_refund_amount" + NEW."sweet_card_refund_amount" = NEW."refund_amount", false);

  IF NEW."refund_mode" = 'PAYMENT' THEN
    IF NEW."external_settlement_id" IS NOT NULL OR target_order."settlement_authority" <> 'PAYMENT' THEN
      RAISE EXCEPTION 'PAYMENT refund authority mismatch' USING ERRCODE = '23514';
    END IF;
    IF NEW."payment_id" IS NOT NULL THEN
      SELECT p."order_id", p."amount"
      INTO source_order_id, payment_amount
      FROM "public"."payments" p
      WHERE p."id" = NEW."payment_id"
      FOR KEY SHARE;
      IF source_order_id IS NULL OR source_order_id <> NEW."order_id" THEN
        RAISE EXCEPTION 'refund source and order mismatch' USING ERRCODE = '23514';
      END IF;
    ELSIF NOT pure_sweet_shape THEN
      RAISE EXCEPTION 'source-free PAYMENT refund requires explicit pure Sweet Card allocation' USING ERRCODE = '23514';
    END IF;

    IF COALESCE(NEW."sweet_card_refund_amount", 0) > 0 THEN
      SELECT sr.* INTO redemption
      FROM "public"."sweet_card_redemptions" sr
      WHERE sr."order_id" = NEW."order_id";
      IF NOT FOUND OR target_order."sweet_card_amount" <> redemption."amount_cents" THEN
        RAISE EXCEPTION 'Sweet Card refund lacks original redemption proof' USING ERRCODE = '23514';
      END IF;
      redemption_amount := redemption."amount_cents";
      SELECT COUNT(*) FILTER (
               WHERE sl."type" = 'REDEEM'
                 AND sl."amount_cents" = -redemption."amount_cents"
             )::INTEGER,
             COUNT(*) FILTER (WHERE sl."type" = 'REVERSAL')::INTEGER
      INTO redeem_ledger_count, reversal_ledger_count
      FROM "public"."sweet_card_ledger" sl
      WHERE sl."order_id" = NEW."order_id"
        AND sl."redemption_id" = redemption."id"
        AND sl."account_id" = redemption."account_id"
        AND sl."type" IN ('REDEEM', 'REVERSAL');
      SELECT COUNT(*)::INTEGER,
             COALESCE(SUM(sri."redeemed_amount_cents"), 0)::BIGINT,
             COUNT(*) FILTER (
               WHERE sri."redeemed_amount_cents" < 0
                  OR sri."redeemed_amount_cents" > sri."eligible_amount_cents"
                  OR (sri."redeemed_amount_cents" > 0 AND sri."eligible_snapshot" IS NOT TRUE)
                  OR oi."order_id" <> NEW."order_id"
             )::INTEGER
      INTO allocation_count, allocation_amount, invalid_allocation_count
      FROM "public"."sweet_card_redemption_items" sri
      JOIN "public"."order_items" oi ON oi."id" = sri."order_item_id"
      WHERE sri."redemption_id" = redemption."id";
      IF redeem_ledger_count <> 1 OR reversal_ledger_count <> 0 OR allocation_count = 0
         OR allocation_amount <> redemption."amount_cents" OR invalid_allocation_count <> 0 THEN
        RAISE EXCEPTION 'Sweet Card refund original settlement proof is incomplete' USING ERRCODE = '23514';
      END IF;
    END IF;

    IF split_present THEN
      SELECT COALESCE(SUM(
               CASE WHEN r."provider_refund_amount" IS NULL AND r."sweet_card_refund_amount" IS NULL
                    THEN r."refund_amount" ELSE r."provider_refund_amount" END
             ), 0)::BIGINT,
             COALESCE(SUM(COALESCE(r."sweet_card_refund_amount", 0)), 0)::BIGINT
      INTO reserved_provider, reserved_sweet
      FROM "public"."refunds" r
      WHERE r."order_id" = NEW."order_id"
        AND r."refund_mode" = 'PAYMENT'
        AND r."status" IN ('pending', 'completed')
        AND r."id" <> NEW."id";
      reserved_provider := reserved_provider + NEW."provider_refund_amount";
      reserved_sweet := reserved_sweet + NEW."sweet_card_refund_amount";
      IF NEW."payment_id" IS NULL AND reserved_provider <> 0 THEN
        RAISE EXCEPTION 'pure Sweet Card refund cannot allocate provider value' USING ERRCODE = '23514';
      END IF;
      IF NEW."payment_id" IS NOT NULL AND reserved_provider > payment_amount THEN
        RAISE EXCEPTION 'provider refund allocation exceeds original Payment' USING ERRCODE = '23514';
      END IF;
      IF reserved_sweet > redemption_amount THEN
        RAISE EXCEPTION 'Sweet Card refund allocation exceeds original redemption' USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSE
    IF NEW."payment_id" IS NOT NULL OR NEW."external_settlement_id" IS NULL
       OR target_order."settlement_authority" <> 'EXTERNAL' THEN
      RAISE EXCEPTION 'MANUAL_EXTERNAL refund authority mismatch' USING ERRCODE = '23514';
    END IF;
    SELECT es."order_id" INTO source_order_id
    FROM "public"."external_settlements" es
    WHERE es."id" = NEW."external_settlement_id"
      AND es."status" IN ('CONFIRMED', 'PARTIALLY_REFUNDED', 'REFUNDED')
    FOR KEY SHARE;
    IF source_order_id IS NULL OR source_order_id <> NEW."order_id" THEN
      RAISE EXCEPTION 'refund source and order mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION "public"."budu_validate_refund_contract"(target_refund_id TEXT) RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  r RECORD;
  o RECORD;
  item_count INTEGER;
  item_amount BIGINT;
  completed_total BIGINT;
  completed_provider BIGINT;
  completed_sweet BIGINT;
  expected_status TEXT;
  source_status TEXT;
  source_amount BIGINT;
  redemption RECORD;
  sweet_allocation_count INTEGER;
  sweet_allocation_amount BIGINT;
  sweet_refund_fact_count INTEGER;
  sweet_refund_fact_amount BIGINT;
  sweet_refund_ledger_count INTEGER;
  invalid_sweet_refund_items INTEGER;
  invalid_sweet_refund_facts INTEGER;
  redeem_ledger_count INTEGER;
  reversal_ledger_count INTEGER;
  redemption_allocation_count INTEGER;
  redemption_allocation_amount BIGINT;
  invalid_redemption_items INTEGER;
BEGIN
  SELECT * INTO r FROM "public"."refunds" WHERE "id" = target_refund_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT COUNT(*)::INTEGER, COALESCE(SUM(ri."amount_cents"), 0)::BIGINT
  INTO item_count, item_amount
  FROM "public"."refund_items" ri
  WHERE ri."refund_id" = r."id";
  IF item_count = 0 OR item_amount <> r."refund_amount" THEN
    RAISE EXCEPTION 'refund item allocation must exactly equal refund amount' USING ERRCODE = '23514';
  END IF;
  IF r."status" <> 'completed' THEN RETURN; END IF;

  SELECT * INTO o FROM "public"."orders" WHERE "id" = r."order_id";
  SELECT COALESCE(SUM(rr."refund_amount"), 0)::BIGINT,
         COALESCE(SUM(
           CASE WHEN rr."provider_refund_amount" IS NULL AND rr."sweet_card_refund_amount" IS NULL
                THEN rr."refund_amount" ELSE rr."provider_refund_amount" END
         ), 0)::BIGINT,
         COALESCE(SUM(COALESCE(rr."sweet_card_refund_amount", 0)), 0)::BIGINT
  INTO completed_total, completed_provider, completed_sweet
  FROM "public"."refunds" rr
  WHERE rr."order_id" = r."order_id" AND rr."status" = 'completed';
  IF completed_total <= 0 OR completed_total > o."payable_amount"
     OR completed_provider < 0 OR completed_sweet < 0
     OR completed_provider + completed_sweet <> completed_total THEN
    RAISE EXCEPTION 'completed refund total or rail allocation is invalid' USING ERRCODE = '23514';
  END IF;
  expected_status := CASE WHEN completed_total = o."payable_amount" THEN 'refunded' ELSE 'partially_refunded' END;
  IF o."status" <> expected_status OR o."payment_status" <> expected_status THEN
    RAISE EXCEPTION 'order refund state does not match completed refund total' USING ERRCODE = '23514';
  END IF;

  IF r."refund_mode" = 'PAYMENT' THEN
    IF o."settlement_authority" <> 'PAYMENT' OR r."external_settlement_id" IS NOT NULL THEN
      RAISE EXCEPTION 'PAYMENT refund authority mismatch' USING ERRCODE = '23514';
    END IF;
    IF r."payment_id" IS NOT NULL THEN
      SELECT p."status", p."amount" INTO source_status, source_amount
      FROM "public"."payments" p
      WHERE p."id" = r."payment_id" AND p."order_id" = r."order_id";
      IF NOT FOUND OR completed_provider > source_amount THEN
        RAISE EXCEPTION 'provider refund exceeds original Payment settlement' USING ERRCODE = '23514';
      END IF;
      IF source_status <> (CASE
           WHEN completed_provider = 0 THEN 'success'
           WHEN completed_provider < source_amount THEN 'partially_refunded'
           ELSE 'refunded'
         END) THEN
        RAISE EXCEPTION 'payment refund state does not match provider refund total' USING ERRCODE = '23514';
      END IF;
    ELSIF (NOT (
      r."provider_refund_amount" = 0
      AND r."sweet_card_refund_amount" > 0
      AND r."provider_refund_amount" + r."sweet_card_refund_amount" = r."refund_amount"
    )) OR completed_provider <> 0 THEN
      RAISE EXCEPTION 'source-free refund is not a valid pure Sweet Card refund' USING ERRCODE = '23514';
    END IF;

    IF completed_sweet > 0 THEN
      SELECT sr.* INTO redemption
      FROM "public"."sweet_card_redemptions" sr
      WHERE sr."order_id" = r."order_id";
      IF NOT FOUND OR o."sweet_card_amount" <> redemption."amount_cents"
         OR completed_sweet > redemption."amount_cents" THEN
        RAISE EXCEPTION 'Sweet Card refund exceeds original settlement' USING ERRCODE = '23514';
      END IF;

      SELECT COUNT(*) FILTER (
               WHERE sl."type" = 'REDEEM'
                 AND sl."amount_cents" = -redemption."amount_cents"
             )::INTEGER,
             COUNT(*) FILTER (WHERE sl."type" = 'REVERSAL')::INTEGER
      INTO redeem_ledger_count, reversal_ledger_count
      FROM "public"."sweet_card_ledger" sl
      WHERE sl."order_id" = r."order_id"
        AND sl."redemption_id" = redemption."id"
        AND sl."account_id" = redemption."account_id"
        AND sl."type" IN ('REDEEM', 'REVERSAL');

      SELECT COUNT(*)::INTEGER,
             COALESCE(SUM(sri."redeemed_amount_cents"), 0)::BIGINT,
             COUNT(*) FILTER (
               WHERE sri."redeemed_amount_cents" < 0
                  OR sri."redeemed_amount_cents" > sri."eligible_amount_cents"
                  OR (sri."redeemed_amount_cents" > 0 AND sri."eligible_snapshot" IS NOT TRUE)
                  OR oi."order_id" <> r."order_id"
                  OR oi."product_id" <> sri."product_id"
                  OR oi."sweet_card_eligible_snapshot" IS DISTINCT FROM sri."eligible_snapshot"
                  OR oi."sweet_card_redeemed_amount" <> sri."redeemed_amount_cents"
             )::INTEGER
      INTO redemption_allocation_count, redemption_allocation_amount, invalid_redemption_items
      FROM "public"."sweet_card_redemption_items" sri
      JOIN "public"."order_items" oi ON oi."id" = sri."order_item_id"
      WHERE sri."redemption_id" = redemption."id";
      IF redeem_ledger_count <> 1 OR reversal_ledger_count <> 0
         OR redemption_allocation_count = 0
         OR redemption_allocation_amount <> redemption."amount_cents"
         OR invalid_redemption_items <> 0 THEN
        RAISE EXCEPTION 'Sweet Card refund original settlement proof is incomplete' USING ERRCODE = '23514';
      END IF;

      SELECT COUNT(*)::INTEGER,
             COALESCE(SUM(scf."amount_cents"), 0)::BIGINT,
             COUNT(*) FILTER (
               WHERE scf."account_id" <> redemption."account_id"
                  OR scf."amount_cents" <> cr."sweet_card_refund_amount"
             )::INTEGER
      INTO sweet_refund_fact_count, sweet_refund_fact_amount, invalid_sweet_refund_facts
      FROM "public"."sweet_card_refunds" scf
      JOIN "public"."refunds" cr ON cr."id" = scf."refund_id" AND cr."status" = 'completed'
      WHERE scf."redemption_id" = redemption."id";
      IF sweet_refund_fact_count = 0 OR sweet_refund_fact_amount <> completed_sweet
         OR invalid_sweet_refund_facts <> 0 THEN
        RAISE EXCEPTION 'Sweet Card refund facts do not match completed rail total' USING ERRCODE = '23514';
      END IF;

      SELECT COUNT(*)::INTEGER, COALESCE(SUM(scfi."amount_cents"), 0)::BIGINT,
             COUNT(*) FILTER (
               WHERE scf."redemption_id" <> redemption."id"
                  OR sri."redemption_id" <> redemption."id"
                  OR scfi."amount_cents" < 0
                  OR scfi."amount_cents" > sri."redeemed_amount_cents"
                  OR ri."refund_id" <> scf."refund_id"
                  OR ri."order_item_id" <> sri."order_item_id"
             )::INTEGER
      INTO sweet_allocation_count, sweet_allocation_amount, invalid_sweet_refund_items
      FROM "public"."sweet_card_refund_items" scfi
      JOIN "public"."sweet_card_refunds" scf ON scf."id" = scfi."sweet_card_refund_id"
      JOIN "public"."refunds" cr ON cr."id" = scf."refund_id" AND cr."status" = 'completed'
      JOIN "public"."sweet_card_redemption_items" sri ON sri."id" = scfi."redemption_item_id"
      JOIN "public"."refund_items" ri ON ri."id" = scfi."refund_item_id"
      WHERE scf."redemption_id" = redemption."id";
      IF sweet_allocation_count = 0 OR sweet_allocation_amount <> completed_sweet
         OR invalid_sweet_refund_items <> 0 OR EXISTS (
           SELECT 1
           FROM "public"."sweet_card_refunds" scf
           JOIN "public"."refunds" cr ON cr."id" = scf."refund_id" AND cr."status" = 'completed'
           LEFT JOIN "public"."sweet_card_refund_items" scfi ON scfi."sweet_card_refund_id" = scf."id"
           WHERE scf."redemption_id" = redemption."id"
           GROUP BY scf."id", scf."amount_cents"
           HAVING COALESCE(SUM(scfi."amount_cents"), 0) <> scf."amount_cents"
         ) THEN
        RAISE EXCEPTION 'Sweet Card refund allocation is incomplete or crosses settlement facts' USING ERRCODE = '23514';
      END IF;

      SELECT COUNT(*)::INTEGER INTO sweet_refund_ledger_count
      FROM "public"."sweet_card_ledger" sl
      JOIN "public"."refunds" cr ON cr."id" = sl."refund_id" AND cr."status" = 'completed'
      WHERE sl."order_id" = r."order_id"
        AND sl."account_id" = redemption."account_id"
        AND sl."type" = 'REFUND'
        AND sl."amount_cents" > 0;
      IF sweet_refund_ledger_count <> sweet_refund_fact_count OR EXISTS (
        SELECT 1
        FROM "public"."sweet_card_refunds" scf
        JOIN "public"."refunds" cr ON cr."id" = scf."refund_id" AND cr."status" = 'completed'
        WHERE scf."redemption_id" = redemption."id"
          AND NOT EXISTS (
            SELECT 1 FROM "public"."sweet_card_ledger" sl
            WHERE sl."refund_id" = scf."refund_id"
              AND sl."order_id" = r."order_id"
              AND sl."account_id" = scf."account_id"
              AND sl."type" = 'REFUND'
              AND sl."amount_cents" = scf."amount_cents"
          )
      ) THEN
        RAISE EXCEPTION 'Sweet Card refund Ledger credit is missing or duplicated' USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSE
    SELECT es."status"::TEXT INTO source_status
    FROM "public"."external_settlements" es
    WHERE es."id" = r."external_settlement_id" AND es."order_id" = r."order_id";
    IF source_status <> (CASE WHEN expected_status = 'refunded' THEN 'REFUNDED' ELSE 'PARTIALLY_REFUNDED' END) THEN
      RAISE EXCEPTION 'external settlement refund state does not match completed refund total' USING ERRCODE = '23514';
    END IF;
  END IF;
END;
$function$;

-- Build and validate exact row-shape replacements before the atomic name swap.
ALTER TABLE "public"."refunds" ADD CONSTRAINT "refunds_source_xor_m64"
CHECK (
  ("payment_id" IS NOT NULL AND "external_settlement_id" IS NULL)
  OR ("payment_id" IS NULL AND "external_settlement_id" IS NOT NULL)
  OR (
    "refund_mode" = 'PAYMENT'
    AND "payment_id" IS NULL
    AND "external_settlement_id" IS NULL
    AND "provider_refund_amount" IS NOT NULL
    AND "provider_refund_amount" = 0
    AND "sweet_card_refund_amount" IS NOT NULL
    AND "sweet_card_refund_amount" > 0
    AND "provider_refund_amount" + "sweet_card_refund_amount" = "refund_amount"
  )
) NOT VALID;

ALTER TABLE "public"."refunds" ADD CONSTRAINT "refunds_mode_source_contract_m64"
CHECK (
  (
    "refund_mode" = 'PAYMENT'
    AND "external_settlement_id" IS NULL
    AND "external_completed_at" IS NULL
    AND "external_refund_reference" IS NULL
    AND (
      "payment_id" IS NOT NULL
      OR (
        "payment_id" IS NULL
        AND "provider_refund_amount" IS NOT NULL
        AND "provider_refund_amount" = 0
        AND "sweet_card_refund_amount" IS NOT NULL
        AND "sweet_card_refund_amount" > 0
        AND "provider_refund_amount" + "sweet_card_refund_amount" = "refund_amount"
      )
    )
  )
  OR (
    "refund_mode" = 'MANUAL_EXTERNAL'
    AND "payment_id" IS NULL
    AND "external_settlement_id" IS NOT NULL
    AND "status" = 'completed'
    AND "provider_refund_no" IS NULL
    AND "completed_at" IS NOT NULL
    AND "external_completed_at" IS NOT NULL
    AND char_length(btrim("requested_by")) > 0
    AND char_length(btrim("approved_by")) > 0
  )
) NOT VALID;

ALTER TABLE "public"."refunds" VALIDATE CONSTRAINT "refunds_source_xor_m64";
ALTER TABLE "public"."refunds" VALIDATE CONSTRAINT "refunds_mode_source_contract_m64";
ALTER TABLE "public"."refunds" DROP CONSTRAINT "refunds_source_xor";
ALTER TABLE "public"."refunds" DROP CONSTRAINT "refunds_mode_source_contract";
ALTER TABLE "public"."refunds" RENAME CONSTRAINT "refunds_source_xor_m64" TO "refunds_source_xor";
ALTER TABLE "public"."refunds" RENAME CONSTRAINT "refunds_mode_source_contract_m64" TO "refunds_mode_source_contract";

COMMIT;
