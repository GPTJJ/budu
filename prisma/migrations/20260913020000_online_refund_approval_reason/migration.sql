-- Additive approval audit; no historical money or refund allocation rewrite.
ALTER TABLE online_refunds ADD COLUMN approval_reason TEXT;
ALTER TABLE online_refunds ADD CONSTRAINT online_refund_reason_length
  CHECK (approval_reason IS NULL OR (length(approval_reason) BETWEEN 1 AND 500));
CREATE TRIGGER online_refund_reason_immutable BEFORE UPDATE OR DELETE ON online_refunds
FOR EACH ROW EXECUTE FUNCTION budu_online_immutable('approval_reason');
