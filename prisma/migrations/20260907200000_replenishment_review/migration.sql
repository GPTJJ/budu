-- Partner Replenishment Gate 5: additive review decisions over immutable
-- Gate 4 requested snapshots. No stock, payment, shipment or legacy data writes.
ALTER TABLE "ReplenishmentOrder"
  ADD COLUMN "approvedTotalAmountCents" BIGINT,
  ADD COLUMN "reviewAction" TEXT,
  ADD COLUMN "reviewReason" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "reviewedAt" TIMESTAMP(3),
  ADD COLUMN "reviewedByActorId" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "reviewedByActorName" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "reviewIdempotencyScope" TEXT,
  ADD COLUMN "reviewIdempotencyKey" TEXT,
  ADD COLUMN "reviewPayloadDigest" TEXT;

ALTER TABLE "ReplenishmentOrderItem"
  ADD COLUMN "approvedQuantityBase" INTEGER,
  ADD COLUMN "approvedLineAmountCents" BIGINT,
  ADD COLUMN "reviewReason" TEXT NOT NULL DEFAULT '';

ALTER TABLE "ReplenishmentOrder"
  DROP CONSTRAINT "ReplenishmentOrder_status_check",
  DROP CONSTRAINT "ReplenishmentOrder_cancel_state_check",
  ADD CONSTRAINT "ReplenishmentOrder_status_check"
    CHECK ("status" IN ('SUBMITTED', 'CANCELLED', 'APPROVED', 'REJECTED')),
  ADD CONSTRAINT "ReplenishmentOrder_review_action_check"
    CHECK ("reviewAction" IS NULL OR "reviewAction" IN ('APPROVE', 'REJECT')),
  ADD CONSTRAINT "ReplenishmentOrder_review_reason_length_check"
    CHECK (char_length("reviewReason") <= 500),
  ADD CONSTRAINT "ReplenishmentOrder_review_idempotency_check" CHECK (
    ("reviewIdempotencyScope" IS NULL AND "reviewIdempotencyKey" IS NULL AND "reviewPayloadDigest" IS NULL)
    OR
    ("reviewIdempotencyScope" IS NOT NULL
      AND char_length("reviewIdempotencyKey") BETWEEN 8 AND 100
      AND char_length("reviewPayloadDigest") = 64)
  ),
  ADD CONSTRAINT "ReplenishmentOrder_lifecycle_facts_check" CHECK (
    ("status" = 'SUBMITTED'
      AND "cancelledAt" IS NULL AND "cancelledByType" IS NULL AND "cancelledByActorId" = ''
      AND "approvedTotalAmountCents" IS NULL AND "reviewAction" IS NULL AND "reviewReason" = ''
      AND "reviewedAt" IS NULL AND "reviewedByActorId" = '' AND "reviewedByActorName" = ''
      AND "reviewIdempotencyScope" IS NULL AND "reviewIdempotencyKey" IS NULL AND "reviewPayloadDigest" IS NULL)
    OR
    ("status" = 'CANCELLED'
      AND "cancelledAt" IS NOT NULL AND "cancelledByType" IS NOT NULL AND "cancelledByActorId" <> ''
      AND "approvedTotalAmountCents" IS NULL AND "reviewAction" IS NULL AND "reviewReason" = ''
      AND "reviewedAt" IS NULL AND "reviewedByActorId" = '' AND "reviewedByActorName" = ''
      AND "reviewIdempotencyScope" IS NULL AND "reviewIdempotencyKey" IS NULL AND "reviewPayloadDigest" IS NULL)
    OR
    ("status" = 'APPROVED'
      AND "cancelledAt" IS NULL AND "cancelledByType" IS NULL AND "cancelledByActorId" = ''
      AND "approvedTotalAmountCents" > 0 AND "reviewAction" = 'APPROVE'
      AND "reviewedAt" IS NOT NULL AND "reviewedByActorId" <> ''
      AND "reviewIdempotencyScope" IS NOT NULL AND "reviewIdempotencyKey" IS NOT NULL AND "reviewPayloadDigest" IS NOT NULL)
    OR
    ("status" = 'REJECTED'
      AND "cancelledAt" IS NULL AND "cancelledByType" IS NULL AND "cancelledByActorId" = ''
      AND "approvedTotalAmountCents" IS NULL AND "reviewAction" = 'REJECT' AND char_length("reviewReason") BETWEEN 1 AND 500
      AND "reviewedAt" IS NOT NULL AND "reviewedByActorId" <> ''
      AND "reviewIdempotencyScope" IS NOT NULL AND "reviewIdempotencyKey" IS NOT NULL AND "reviewPayloadDigest" IS NOT NULL)
  );

ALTER TABLE "ReplenishmentOrderItem"
  ADD CONSTRAINT "ReplenishmentOrderItem_approved_decision_check" CHECK (
    ("approvedQuantityBase" IS NULL AND "approvedLineAmountCents" IS NULL AND "reviewReason" = '')
    OR
    ("approvedQuantityBase" = 0 AND "approvedLineAmountCents" = 0)
    OR
    ("approvedQuantityBase" > 0 AND "approvedLineAmountCents" > 0)
  ),
  ADD CONSTRAINT "ReplenishmentOrderItem_review_reason_length_check"
    CHECK (char_length("reviewReason") <= 300);

CREATE UNIQUE INDEX "ReplenishmentOrder_reviewIdempotencyScope_reviewIdempotencyKey_key"
  ON "ReplenishmentOrder"("reviewIdempotencyScope", "reviewIdempotencyKey");

-- Gate 4 submission fields remain protected by its existing triggers. These
-- triggers make the first review decision append-only and prevent physical
-- removal of review evidence.
CREATE FUNCTION "prevent_replenishment_order_review_rewrite"()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."reviewAction" IS NOT NULL AND ROW(
    NEW."approvedTotalAmountCents", NEW."reviewAction", NEW."reviewReason", NEW."reviewedAt",
    NEW."reviewedByActorId", NEW."reviewedByActorName", NEW."reviewIdempotencyScope",
    NEW."reviewIdempotencyKey", NEW."reviewPayloadDigest"
  ) IS DISTINCT FROM ROW(
    OLD."approvedTotalAmountCents", OLD."reviewAction", OLD."reviewReason", OLD."reviewedAt",
    OLD."reviewedByActorId", OLD."reviewedByActorName", OLD."reviewIdempotencyScope",
    OLD."reviewIdempotencyKey", OLD."reviewPayloadDigest"
  ) THEN
    RAISE EXCEPTION 'REPLENISHMENT_REVIEW_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ReplenishmentOrder_review_immutable"
BEFORE UPDATE ON "ReplenishmentOrder"
FOR EACH ROW EXECUTE FUNCTION "prevent_replenishment_order_review_rewrite"();

CREATE FUNCTION "enforce_replenishment_order_state_transition"()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."status" IS DISTINCT FROM NEW."status"
    AND NOT (OLD."status" = 'SUBMITTED' AND NEW."status" IN ('CANCELLED', 'APPROVED', 'REJECTED')) THEN
    RAISE EXCEPTION 'REPLENISHMENT_ORDER_STATE_TRANSITION_FORBIDDEN';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ReplenishmentOrder_state_transition"
BEFORE UPDATE ON "ReplenishmentOrder"
FOR EACH ROW EXECUTE FUNCTION "enforce_replenishment_order_state_transition"();

CREATE FUNCTION "prevent_replenishment_order_item_review_rewrite"()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."approvedQuantityBase" IS NOT NULL AND ROW(
    NEW."approvedQuantityBase", NEW."approvedLineAmountCents", NEW."reviewReason"
  ) IS DISTINCT FROM ROW(
    OLD."approvedQuantityBase", OLD."approvedLineAmountCents", OLD."reviewReason"
  ) THEN
    RAISE EXCEPTION 'REPLENISHMENT_REVIEW_ITEM_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ReplenishmentOrderItem_review_immutable"
BEFORE UPDATE ON "ReplenishmentOrderItem"
FOR EACH ROW EXECUTE FUNCTION "prevent_replenishment_order_item_review_rewrite"();
