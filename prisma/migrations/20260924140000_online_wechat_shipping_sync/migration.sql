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
 -- 履约方式，与 OnlineFulfillmentAuthorization.method 同义。两种履约的物流事实
 -- 完全不对称，所以必须真实表达，不允许用 'PICKUP'/'NONE'/'SELF' 或空运单号之类的
 -- sentinel 去冒充快递事实。
 method TEXT NOT NULL,
 -- 微信官方 logistics_type：1 = 实体物流配送（快递），4 = 用户自提。
 logistics_type INTEGER NOT NULL,
 -- 微信官方 delivery_id。注意它**不是** BUDU 页面码：页面写 YUNDA，微信要 YD，
 -- 两个编码空间不同（见 server/wechat-delivery-codes.js）。
 -- PICKUP 没有承运商/运单，这两列为 NULL —— 由下面的 CHECK 强制。
 delivery_id TEXT,
 tracking_no TEXT,
 -- 首次发货时间（authorization.created_at），绝不用重试时间冒充。
 upload_time TIMESTAMP(3) NOT NULL,
 -- 防止同一 settlement 被不同的物流数据覆盖（指纹含 method，见服务端）。
 payload_fingerprint TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0,
 verify_attempts INTEGER NOT NULL DEFAULT 0,
 -- 「唯一一次受控重传」的持久化预算。微信规定每笔支付单仅有一次重新发货机会，
 -- 所以这里由数据库兜住上限：即使 worker 重启、换实例、并发 claim，也不会出现第二次
 -- 重传（服务端用 `AND reupload_count = 0` 的条件 UPDATE 原子赢取许可）。
 -- 首次 upload 不计入，保持 0。
 reupload_count INTEGER NOT NULL DEFAULT 0,
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
 -- 每笔支付单最多一次受控重传；数据库层不可绕过。
 CHECK (reupload_count BETWEEN 0 AND 1),
 CHECK (method IN ('DELIVERY','PICKUP')),
 -- 两种履约各自成立，互斥且穷尽：
 --   DELIVERY → logistics_type 必须是快递(1)，且**必须**有真实运单号
 --   PICKUP   → logistics_type 必须是用户自提(4)，承运商与运单号必须为 NULL
 -- 绝不允许用 'PICKUP'/'NONE'/'SELF' 或空运单号之类的 sentinel 冒充快递事实。
 CHECK (
   (method = 'DELIVERY' AND logistics_type = 1
     AND tracking_no IS NOT NULL AND length(tracking_no) BETWEEN 1 AND 128)
   OR
   (method = 'PICKUP' AND logistics_type = 4
     AND delivery_id IS NULL AND tracking_no IS NULL)
 ),
 -- 会被上传、或已经声称 SYNCED 的 DELIVERY 行，必须有真实的微信官方 delivery_id
 -- （不是 BUDU 页面码，也不是 'UNMAPPED_…' 这类占位串）。唯一允许为空的情形是
 -- 「承载得了运单、但承运商映射不到官方编码」因而没上传就判死的 FAILED 行。
 CHECK (method <> 'DELIVERY' OR delivery_id IS NOT NULL OR status = 'FAILED'),
 CHECK (delivery_id IS NULL OR length(delivery_id) BETWEEN 1 AND 128),
 -- SYNCED 只能由 get_order 核实产生，因此必然带 verified_at；反过来，没有核实
 -- 过的时间戳就不允许声称已同步。
 CHECK ((status = 'SYNCED') = (verified_at IS NOT NULL))
);
CREATE INDEX online_wechat_shipping_sync_status_available_at_idx
 ON online_wechat_shipping_sync(status, available_at);
-- 微信一旦收下这次上传，产生它的 payload 就不允许再被改写：指纹变了就意味着
-- 我们不再知道微信手上到底持有哪一份发货信息。重试只允许重放同一份内容。
-- method / logistics_type 也在其中：把一笔履约从快递改写成自提（或反过来）是在
-- 改「微信收下的是哪一种发货信息」，等同于篡改既成事实。
CREATE FUNCTION online_wechat_shipping_payload_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.upload_accepted_at IS NOT NULL AND (
      NEW.method              IS DISTINCT FROM OLD.method
   OR NEW.logistics_type     IS DISTINCT FROM OLD.logistics_type
   OR NEW.payload_fingerprint IS DISTINCT FROM OLD.payload_fingerprint
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
