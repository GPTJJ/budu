-- 首页轮播后台（营销模块）
-- OS 为编辑权威；发布时才写 CloudBase `home_banners/config`（单文档整包覆盖），
-- 因此这里只新增两张表，不动任何既有数据。

CREATE TABLE "online_banners" (
    "id" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "image" TEXT NOT NULL DEFAULT '',
    "title" TEXT NOT NULL DEFAULT '',
    "en" TEXT NOT NULL DEFAULT '',
    "subtitle" TEXT NOT NULL DEFAULT '',
    "date_text" TEXT NOT NULL DEFAULT '',
    "cta_text" TEXT NOT NULL DEFAULT '',
    "link_type" TEXT NOT NULL DEFAULT 'none',
    "link_value" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by_id" TEXT,
    CONSTRAINT "online_banners_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "online_banners_enabled_sort_order_idx" ON "online_banners"("enabled", "sort_order");

CREATE TABLE "online_banner_publish" (
    "id" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 0,
    "checksum" TEXT NOT NULL DEFAULT '',
    "published_at" TIMESTAMP(3),
    "last_error" TEXT NOT NULL DEFAULT '',
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "online_banner_publish_pkey" PRIMARY KEY ("id")
);
