-- Retire the isolated Partner Supply trial. Partner and PartnerStore remain canonical
-- for the formal replenishment system. Abort if any trial order is outside the
-- explicitly disposable Qinhuangdao experience set.
BEGIN;
LOCK TABLE "PartnerSupplyOrder" IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "PartnerSupplyOrder"
    WHERE "partnerNameSnapshot" NOT LIKE '%秦皇岛%'
  ) THEN
    RAISE EXCEPTION 'PARTNER_SUPPLY_REAL_DATA_REVIEW_REQUIRED';
  END IF;
END $$;

DROP TABLE "PartnerReceipt";
DROP TABLE "PartnerSupplyItem";
DROP TABLE "PartnerSupplyOrder";
ALTER TABLE "InventoryItem" DROP COLUMN "partnerSupplyEnabled";
COMMIT;
