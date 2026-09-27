-- Add optional transfer packaging specifications without changing existing products.
ALTER TABLE "InventoryItem"
  ADD COLUMN "transferBoxEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "transferBoxWeightGrams" INTEGER,
  ADD COLUMN "transferPieceEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "transferPieceWeightGrams" INTEGER;

-- Existing transfer rows remain legacy quantities. New box/piece rows store their
-- real quantity in `quantity` and snapshot the applicable unit weight.
ALTER TABLE "TransferItem"
  ADD COLUMN "quantityUnit" TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN "unitWeightGramsSnapshot" INTEGER;

ALTER TABLE "InventoryItem"
  ADD CONSTRAINT "InventoryItem_transferBoxWeightGrams_positive"
    CHECK ("transferBoxWeightGrams" IS NULL OR "transferBoxWeightGrams" > 0),
  ADD CONSTRAINT "InventoryItem_transferBoxSpecification_complete"
    CHECK (NOT "transferBoxEnabled" OR "transferBoxWeightGrams" IS NOT NULL),
  ADD CONSTRAINT "InventoryItem_transferPieceWeightGrams_positive"
    CHECK ("transferPieceWeightGrams" IS NULL OR "transferPieceWeightGrams" > 0),
  ADD CONSTRAINT "InventoryItem_transferPieceSpecification_complete"
    CHECK (NOT "transferPieceEnabled" OR "transferPieceWeightGrams" IS NOT NULL);

ALTER TABLE "TransferItem"
  ADD CONSTRAINT "TransferItem_quantityUnit_valid"
    CHECK ("quantityUnit" IN ('legacy', 'box', 'piece')),
  ADD CONSTRAINT "TransferItem_unitWeightGramsSnapshot_positive"
    CHECK ("unitWeightGramsSnapshot" IS NULL OR "unitWeightGramsSnapshot" > 0),
  ADD CONSTRAINT "TransferItem_unitWeightGramsSnapshot_complete"
    CHECK ("quantityUnit" = 'legacy' OR "unitWeightGramsSnapshot" IS NOT NULL);
