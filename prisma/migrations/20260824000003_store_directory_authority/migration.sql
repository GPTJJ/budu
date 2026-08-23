-- Data Authority DA-2.3：门店目录权威（active 标记支持可逆退役，不硬删被引用门店）
ALTER TABLE "Store" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;
