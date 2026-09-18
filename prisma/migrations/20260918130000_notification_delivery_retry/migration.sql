-- Additive, candidate only. Bounded retry bookkeeping for outbound channel
-- delivery. Existing rows keep their current meaning: attempts 0 means "not
-- retried yet", and a NULL next_attempt_at means "no retry scheduled".
ALTER TABLE notification_deliveries ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notification_deliveries ADD COLUMN next_attempt_at TIMESTAMP(3);
ALTER TABLE notification_deliveries ADD CONSTRAINT notification_deliveries_attempts_nonnegative CHECK (attempts >= 0);
CREATE INDEX notification_deliveries_status_next_attempt_at_idx ON notification_deliveries(status, next_attempt_at);
