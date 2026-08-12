-- budu 档案馆：图片缩略图（列表卡片展示小图，减少大图加载）

ALTER TABLE "asset_files" ADD COLUMN "thumbnail" TEXT NOT NULL DEFAULT '';
