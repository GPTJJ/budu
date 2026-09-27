-- Rollback for 20260924140000_online_wechat_shipping_sync.
--
-- Only drops what the forward migration created. It touches no existing table,
-- no settlement/refund/tender row, and no fulfillment authorization — the sync
-- state is a subordinate fact with no inbound references.
DROP TRIGGER IF EXISTS online_wechat_shipping_no_payload_rewrite ON online_wechat_shipping_sync;
DROP FUNCTION IF EXISTS online_wechat_shipping_payload_immutable();
DROP INDEX IF EXISTS online_wechat_shipping_sync_status_available_at_idx;
DROP TABLE IF EXISTS online_wechat_shipping_sync;
