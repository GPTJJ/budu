-- ONLINE-CATALOG-COMBO-001
-- Combo（自由搭配）商品需要连同口味槽位一起发布，否则发布器会把 CloudBase 的
-- `combo` 字段写成 null，导致小程序端的口味选择器和结算校验失效。
-- 这里把组合定义存进 OS 档案，发布时原样带出；口味范围仍以 POS 侧为准。

ALTER TABLE "online_product_profiles" ADD COLUMN "combo" JSONB;
