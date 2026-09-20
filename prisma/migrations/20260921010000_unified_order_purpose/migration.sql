BEGIN;
CREATE TYPE "OrderPurpose" AS ENUM ('REAL', 'TEST', 'ACCEPTANCE_TEST', 'LEGACY_UNCLASSIFIED');
-- One atomic transition: every existing row is unknown, every subsequent ordinary insert is REAL.
ALTER TABLE "ReplenishmentOrder" ADD COLUMN "purpose" "OrderPurpose" NOT NULL DEFAULT 'LEGACY_UNCLASSIFIED';
ALTER TABLE "TransferRequest" ADD COLUMN "purpose" "OrderPurpose" NOT NULL DEFAULT 'LEGACY_UNCLASSIFIED';
ALTER TABLE "ReplenishmentOrder" ALTER COLUMN "purpose" SET DEFAULT 'REAL';
ALTER TABLE "TransferRequest" ALTER COLUMN "purpose" SET DEFAULT 'REAL';

CREATE TABLE "OrderPurposeAudit" (
  "id" TEXT PRIMARY KEY, "operationKey" TEXT NOT NULL UNIQUE,
  "action" TEXT NOT NULL CHECK ("action" IN ('CLASSIFY', 'CORRECT', 'DELETE_TEST', 'CREATE_TEST')),
  "orderType" TEXT NOT NULL CHECK ("orderType" IN ('partner', 'transfer')),
  "orderId" TEXT NOT NULL, "orderNo" TEXT NOT NULL,
  "actorId" TEXT NOT NULL, "actorRole" TEXT NOT NULL CHECK ("actorRole" IN ('developer','admin')),
  "reason" TEXT NOT NULL CHECK (length(trim("reason")) BETWEEN 1 AND 500),
  "beforePurpose" "OrderPurpose", "afterPurpose" "OrderPurpose",
  "snapshot" JSONB NOT NULL, "safety" JSONB NOT NULL, "deletedCounts" JSONB NOT NULL,
  "transactionId" BIGINT NOT NULL DEFAULT txid_current(), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "OrderPurposeAudit_orderType_orderId_createdAt_idx" ON "OrderPurposeAudit" ("orderType", "orderId", "createdAt");

CREATE FUNCTION order_purpose_audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'ORDER_PURPOSE_AUDIT_IMMUTABLE'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "User" WHERE id=NEW."actorId" AND role=NEW."actorRole" AND status='active' AND role IN ('developer','admin')) THEN
    RAISE EXCEPTION 'ORDER_PURPOSE_ACTOR_FORBIDDEN';
  END IF;
  NEW."transactionId" := txid_current();
  NEW."createdAt" := CURRENT_TIMESTAMP;
  RETURN NEW;
END $$;
CREATE TRIGGER "OrderPurposeAudit_guard" BEFORE INSERT OR UPDATE OR DELETE ON "OrderPurposeAudit" FOR EACH ROW EXECUTE FUNCTION order_purpose_audit_guard();

CREATE FUNCTION order_purpose_change_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind TEXT := CASE TG_TABLE_NAME WHEN 'ReplenishmentOrder' THEN 'partner' ELSE 'transfer' END;
BEGIN
  IF NEW.purpose IS DISTINCT FROM OLD.purpose AND NOT EXISTS (
    SELECT 1 FROM "OrderPurposeAudit" a WHERE a."orderType"=kind AND a."orderId"=OLD.id
      AND a."transactionId"=txid_current() AND a.action IN ('CLASSIFY','CORRECT')
      AND a."beforePurpose"=OLD.purpose AND a."afterPurpose"=NEW.purpose
  ) THEN RAISE EXCEPTION 'ORDER_PURPOSE_CHANGE_REQUIRES_AUDIT'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ReplenishmentOrder_purpose_guard" BEFORE UPDATE ON "ReplenishmentOrder" FOR EACH ROW EXECUTE FUNCTION order_purpose_change_guard();
CREATE TRIGGER "TransferRequest_purpose_guard" BEFORE UPDATE ON "TransferRequest" FOR EACH ROW EXECUTE FUNCTION order_purpose_change_guard();

CREATE FUNCTION order_purpose_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind TEXT := CASE TG_TABLE_NAME WHEN 'ReplenishmentOrder' THEN 'partner' ELSE 'transfer' END;
BEGIN
  IF NEW.purpose='LEGACY_UNCLASSIFIED' THEN RAISE EXCEPTION 'LEGACY_PURPOSE_INSERT_FORBIDDEN'; END IF;
  IF NEW.purpose IN ('TEST','ACCEPTANCE_TEST') AND NOT EXISTS (
    SELECT 1 FROM "OrderPurposeAudit" a WHERE a."orderType"=kind AND a."orderId"=NEW.id
      AND a."transactionId"=txid_current() AND a.action='CREATE_TEST' AND a."afterPurpose"=NEW.purpose
  ) THEN RAISE EXCEPTION 'TEST_ORDER_CREATE_REQUIRES_AUDIT'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "ReplenishmentOrder_test_insert_guard" AFTER INSERT ON "ReplenishmentOrder" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION order_purpose_insert_guard();
CREATE CONSTRAINT TRIGGER "TransferRequest_test_insert_guard" AFTER INSERT ON "TransferRequest" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION order_purpose_insert_guard();

CREATE FUNCTION controlled_test_order_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind TEXT; target_id TEXT; target_purpose "OrderPurpose";
BEGIN
  kind := CASE WHEN TG_TABLE_NAME LIKE 'Replenishment%' THEN 'partner' ELSE 'transfer' END;
  IF TG_TABLE_NAME='ReplenishmentOrderItem' THEN
    target_id := OLD."replenishmentOrderId";
    SELECT purpose INTO target_purpose FROM "ReplenishmentOrder" WHERE id=target_id;
  ELSE
    target_id := OLD.id; target_purpose := OLD.purpose;
  END IF;
  IF target_purpose NOT IN ('TEST','ACCEPTANCE_TEST') OR target_purpose IS NULL OR NOT EXISTS (
    SELECT 1 FROM "OrderPurposeAudit" a WHERE a."orderType"=kind AND a."orderId"=target_id
      AND a."transactionId"=txid_current() AND a.action='DELETE_TEST' AND a."beforePurpose"=target_purpose
      AND a.safety->>'safe'='true'
  ) THEN RAISE EXCEPTION 'TEST_ORDER_DELETE_FORBIDDEN'; END IF;
  RETURN OLD;
END $$;
-- Replace only the two permanent blanket-delete guards with audited exact-order guards.
DROP TRIGGER "ReplenishmentOrder_delete_forbidden" ON "ReplenishmentOrder";
DROP TRIGGER "ReplenishmentOrderItem_delete_forbidden" ON "ReplenishmentOrderItem";
CREATE TRIGGER "ReplenishmentOrder_delete_forbidden" BEFORE DELETE ON "ReplenishmentOrder" FOR EACH ROW EXECUTE FUNCTION controlled_test_order_delete_guard();
CREATE TRIGGER "ReplenishmentOrderItem_delete_forbidden" BEFORE DELETE ON "ReplenishmentOrderItem" FOR EACH ROW EXECUTE FUNCTION controlled_test_order_delete_guard();
CREATE TRIGGER "TransferRequest_test_delete_guard" BEFORE DELETE ON "TransferRequest" FOR EACH ROW EXECUTE FUNCTION controlled_test_order_delete_guard();

-- Notifications have soft references. Serialize creation with classification /
-- deletion so a delayed notifier cannot create an orphan or send after deletion.
CREATE FUNCTION order_notification_purpose_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p "OrderPurpose";
BEGIN
  IF NEW.ref_type='partner_replenishment' THEN
    SELECT purpose INTO p FROM "ReplenishmentOrder" WHERE id=NEW.ref_id FOR UPDATE;
  ELSIF NEW.ref_type='transfer' THEN
    SELECT purpose INTO p FROM "TransferRequest" WHERE id=NEW.ref_id FOR UPDATE;
  ELSE RETURN NEW;
  END IF;
  IF p IS NULL THEN RAISE EXCEPTION 'ORDER_NOT_FOUND_OR_DELETED'; END IF;
  IF p IN ('TEST','ACCEPTANCE_TEST') THEN RAISE EXCEPTION 'TEST_ORDER_EXTERNAL_NOTIFICATION_FORBIDDEN'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "notifications_order_purpose_guard" BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION order_notification_purpose_guard();
COMMIT;
