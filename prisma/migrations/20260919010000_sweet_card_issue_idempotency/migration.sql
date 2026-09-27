-- Additive request-level idempotency index for Sweet Card batch issuance.
-- The operation row is created in the same transaction as its Batch, Cards,
-- Credentials and ISSUE Ledger entries. Historical value records are untouched.
CREATE TABLE sweet_card_issue_operations (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT sweet_card_issue_operations_request_key_check
    CHECK (request_key ~ '^[A-Za-z0-9:_-]{8,128}$'),
  CONSTRAINT sweet_card_issue_operations_actor_id_check
    CHECK (length(actor_id) BETWEEN 1 AND 160),
  CONSTRAINT sweet_card_issue_operations_fingerprint_check
    CHECK (request_fingerprint ~ '^[a-f0-9]{64}$')
);

CREATE UNIQUE INDEX sweet_card_issue_operations_actor_id_request_key_key
  ON sweet_card_issue_operations(actor_id, request_key);
CREATE UNIQUE INDEX sweet_card_issue_operations_batch_id_key
  ON sweet_card_issue_operations(batch_id);
CREATE INDEX sweet_card_issue_operations_created_at_idx
  ON sweet_card_issue_operations(created_at);

ALTER TABLE sweet_card_issue_operations
  ADD CONSTRAINT sweet_card_issue_operations_batch_id_fkey
  FOREIGN KEY (batch_id) REFERENCES sweet_card_batches(id)
  ON DELETE RESTRICT ON UPDATE CASCADE;
