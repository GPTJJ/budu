-- Keep every existing store's pickup availability unchanged. Store.active
-- remains the independent authority for warehouse and operating transactions.
ALTER TABLE "Store" ADD COLUMN "pickup_enabled" BOOLEAN NOT NULL DEFAULT true;
