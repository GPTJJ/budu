-- Additive, candidate only. WeChat 小程序「发货信息管理」(upload_shipping_info)
-- 的同步状态。
--
-- 这不是第二套发货权威：发货事实永远是 online_fulfillment_authorizations。
-- 微信同步失败不得撤销发货、不得让商家看到「发货失败」、不得改支付/退款/
-- 甜意卡状态，也不得改写 canonical fulfillment。
--
-- 与 online_logistics_traces 是**两个互不相干的微信能力**，状态独立：
--   online_logistics_traces  → trace_waybill（物流轨迹 / waybill_token）
--   online_wechat_shipping_sync → upload_shipping_info（平台发货信息 / 资金结算）
-- 两者共用 access_token authority、发货事实、transaction_id、openid 与 worker
-- 基础设施，但状态、重试节奏与终态判据各自独立。
CREATE TABLE online_wechat_shipping_sync (
 id TEXT PRIMARY KEY,
 settlement_id TEXT NOT NULL UNIQUE REFERENCES online_settlements(id) ON DELETE RESTRICT,
 authorization_id TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'PENDING_UPLOAD',
 -- 微信官方 delivery_id。注意它**不是** BUDU 页面码：页面写 YUNDA，微信要 YD，
 -- 两个编码空间不同（见 server/wechat-delivery-codes.js）。
 delivery_id TEXT NOT NULL,
 tracking_no TEXT NOT NULL,
 -- 首次发货时间（authorization.created_at），绝不用重试时间冒充。
 upload_time TIMESTAMP(3) NOT NULL,
 -- 防止同一 settlement 被不同的物流数据覆盖。
 payload_fingerprint TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0,
 verify_attempts INTEGER NOT NULL DEFAULT 0,
 available_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 lease_until TIMESTAMP(3),
 lease_owner TEXT,
 last_error TEXT,
 upload_accepted_at TIMESTAMP(3),
 verified_at TIMESTAMP(3),
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK (status IN ('PENDING_UPLOAD','PENDING_VERIFY','SYNCED','UNSUPPORTED','FAILED')),
 CHECK (attempts >= 0),
 CHECK (verify_attempts >= 0),
 CHECK (length(delivery_id) BETWEEN 1 AND 128),
 CHECK (length(tracking_no) BETWEEN 1 AND 128),
 -- SYNCED 只能由 get_order 核实产生，因此必然带 verified_at；反过来，没有核实
 -- 过的时间戳就不允许声称已同步。
 CHECK ((status = 'SYNCED') = (verified_at IS NOT NULL))
);
CREATE INDEX online_wechat_shipping_sync_status_available_at_idx
 ON online_wechat_shipping_sync(status, available_at);
-- 微信一旦收下这次上传，产生它的 payload 就不允许再被改写：指纹变了就意味着
-- 我们不再知道微信手上到底持有哪一份发货信息。重试只允许重放同一份内容。
CREATE FUNCTION online_wechat_shipping_payload_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.upload_accepted_at IS NOT NULL AND (
      NEW.payload_fingerprint IS DISTINCT FROM OLD.payload_fingerprint
   OR NEW.delivery_id          IS DISTINCT FROM OLD.delivery_id
   OR NEW.tracking_no          IS DISTINCT FROM OLD.tracking_no
   OR NEW.upload_time          IS DISTINCT FROM OLD.upload_time) THEN
  RAISE EXCEPTION 'ONLINE_WECHAT_SHIPPING_PAYLOAD_IMMUTABLE';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER online_wechat_shipping_no_payload_rewrite
 BEFORE UPDATE ON online_wechat_shipping_sync
 FOR EACH ROW EXECUTE FUNCTION online_wechat_shipping_payload_immutable();
