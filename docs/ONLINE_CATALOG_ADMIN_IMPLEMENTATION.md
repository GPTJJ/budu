# ONLINE-CATALOG-ADMIN-001 实现说明

日期：2026-11-12
分支：`codex/online-catalog-admin-001`（基于生产基线 `e747fbd`）
状态：候选实现，未部署、未执行生产迁移、未写生产 CloudBase

## 1. 目标与架构

目标：在 OS 页面内管理小程序商城商品，支持新增商品、修改标题/价格/规格/图片、上下架、新增分类和发布，不再每次去 CloudBase 控制台。

架构：

```
OS 管理页 /online-catalog
  → Postgres（OnlineCategory / OnlineProductProfile，管理权威）
  → 显式“发布”
  → CloudBase products 集合（小程序读模型）
  → 小程序 catalog 云函数（status=on，60s 缓存）
```

- 小程序读取链路不改，不需要发版。
- 发布失败不影响 OS 保存；保留上一版已发布内容，页面显示失败原因。
- CloudBase 密钥只在 OS 服务端环境变量中，不进前端。

## 2. 改动清单

| 文件 | 作用 |
|---|---|
| `prisma/schema.prisma` | 新增 `OnlineCategory`、`OnlineProductProfile`，`InventoryItem` 增加 1:1 反向关系 |
| `prisma/migrations/20261112120000_online_catalog_admin/migration.sql` | 两张表、唯一索引、外键 |
| `server/online-catalog.js` | 分类/商品 CRUD、发布、批量发布、从 CloudBase 导入现有商品、权限校验 |
| `server/online-catalog-publisher.js` | CloudBase 发布器：图片上传、商品 upsert、`_meta.categories`、回读校验 |
| `server/app.js` | 挂载 `/api/v2/online-catalog`，权限规则 `PRODUCT_CENTER` |
| `src/components/OnlineCatalogPage.jsx` | 独立管理页：列表、筛选、新建/编辑、分类管理、发布、导入现有 |
| `src/App.jsx` | 新增 `/online-catalog` 路由 |
| `scripts/test-online-catalog-admin.mjs` | 10 项单元测试（字段投影、价格、媒体、skuId、发布幂等、分类 meta） |
| `package.json` | 新增 `@cloudbase/node-sdk ^3.18.7`、`test:online-catalog` |

## 3. 数据模型

### OnlineCategory

`id / name(unique) / sortOrder / isActive / meta(JSONB) / version / createdAt / updatedAt`

- `meta` 存小程序分类视觉元数据：`{color,bg,border,sub}`。
- 不支持删除，只支持停用；有商品的分类不能删除（当前 UI 只提供停用）。

### OnlineProductProfile

`id / inventoryItemId(unique) / mpId(unique) / onlineCategoryId / title / subtitle / spec / unit / priceCents / shelfLife / storage / media(JSONB) / sortOrder / status / publishState / publishedVersion / publishedAt / lastError / version / timestamps`

- 商品身份仍是 `InventoryItem.id`；`mpId` 是现有 CloudBase `products.id`（c1/s1/...），创建后不可改。
- `status`：`DRAFT / ON / OFF`。
- `publishState`：`UNPUBLISHED / PUBLISHED / FAILED`。
- `media`：`{cover,gallery:[],detail:[]}`，元素可以是 CloudBase file id、HTTPS URL、`/images/...` 或待上传的 data URL。

## 4. 关键业务规则

### 4.1 线上价格

- 默认取 `InventoryItem.salePriceCents`；允许单独设置 `priceCents`。
- 上架（`status=ON`）必须有大于 0 的线上价。
- 线上价与 POS 价不一致时，页面不做强制拦截，但两列都可见，便于核对。

### 4.2 线上结算资格（必须）

每个新商品必须在 `online_product_policies` 中有一条映射，否则线上结算会返回 `CATALOG_MAPPING_REQUIRED`，无法下单。

- `namespace = cloudbase-miniprogram`
- `externalProductId = mpId`
- `externalSkuId = sku-<sha256(JSON.stringify([mpId, null]))>`（非组合商品）
- `productId = InventoryItem.id`
- `enabled = status === 'ON'`

该 `skuId` 与小程序 `cloudfunctions/orders/online-catalog.js` 的算法逐字一致，不能自行改成商品 SKU。

组合商品（`combo != null`，如 `bb`）有多个 SKU 组合，当前导入逻辑会跳过并单独报告；不要用单条 policy 冒充组合商品。

### 4.3 发布

1. 发布所有启用分类到 `products/_meta.categories`。
2. 上传 `media` 中的 data URL 到 CloudBase 存储，文档只存 `cloud://` file id。
3. 按 `id` upsert `products` 文档，只更新白名单字段，不删除未知文档。
4. 回读并按稳定 JSON 计算 checksum，逐字段比对。
5. 成功写 `publishState=PUBLISHED / publishedAt / publishedVersion`；失败写 `FAILED / lastError`，保留上一版线上内容。

白名单字段与小程序 `catalog` 云函数一致：
`id/name/category/status/sortOrder/unit/spec/unitPriceCent/shelfLife/storage/subtitle/media/combo/categoryMeta`。

### 4.4 从 CloudBase 导入现有商品

`POST /api/v2/online-catalog/import-existing`：

- 读取生产 `products` 全量（最多 200 条）。
- 跳过 `_meta` 和 `combo` 商品。
- 按 `InventoryItem.name` 精确匹配；未匹配、OS 未启用、已管理的分别报告。
- 匹配成功的建立 profile + policy，`publishState=PUBLISHED`（因为线上文档已存在，不重写内容）。
- 返回 `created / skipped / unmatched / combo / inactive / failed` 明细。

这是现有 28 个商品的一次性迁移入口。匹配不上的商品需要在 OS 商品中心补齐名称或后续做手工映射。

## 5. 页面

路径：`/online-catalog`（独立页，不在 Dashboard 侧边栏内）。

功能：

- 分类筛选、商品列表（图片/标题/mpId/分类/线上价/状态/发布状态/最后错误）。
- 新增商品：两种模式
  - 新建 OS 商品 + 线上档案（同表单，要求名称、SKU、售价、成本价）。
  - 选择现有 OS 商品 + 线上档案（适合接管已有商品；要接管 CloudBase 现有商品时填写原 `mpId`，或直接用“导入现有”）。
- 编辑：标题、副标题、分类、线上价、单位、规格、保质期、保存方式、排序、状态、封面图。
- 分类管理：新增、改名、排序、停用。
- 发布单条、批量发布接口（页面当前是单条发布）。
- 导入现有商品。
- 发布配置状态提示：未配置 `TCB_*` 时页面显示黄色提示，保存/导入可用、发布不可用。
- 发布预览：发布前查看将写入 CloudBase 的文档（图片以占位符显示），用于核对字段和价格。
- 封面图前端压缩到 <600KB；轮播图（最多 9 张）和详情图（最多 20 张）支持多选上传与逐张移除；发布时统一上传 CloudBase 存储。

## 6. 权限与安全

- 页面要求已登录 OS；接口要求 `PRODUCT_CENTER` 模块权限，且 `requireBusiness` 拒绝收银角色。
- `isSuperUser` 或 `manager + PRODUCT_CENTER` 可管理；发布同样受此限制。
- CloudBase 凭据仅服务端环境变量：`TCB_ENV_ID`、`TCB_SECRET_ID`、`TCB_SECRET_KEY`。
- 不删除 CloudBase 未知文档；不做整集合覆盖。
- 分类 `_meta` 更新保留其他字段（存在则 update，不存在则 set）。
- 所有写接口走 Prisma 参数化查询；图片只接受 data URL/cloud/https/`/images/`。

## 7. 部署步骤（候选，未执行）

1. `npm install`（新增 `@cloudbase/node-sdk`）。
2. `npx prisma migrate deploy`（应用 `20261112120000_online_catalog_admin`）。
3. `npx prisma generate`（Dockerfile 已有此步）。
4. 在 OS 运行环境配置 `TCB_ENV_ID=budu-d6gz358ixe39faf43`、`TCB_SECRET_ID`、`TCB_SECRET_KEY`。
5. `npm run build`。
6. 重启 OS 容器；确认 `/online-catalog` 可打开。
7. 打开页面 → “导入现有” → 核对 created/unmatched/combo 报告。
8. 选一个商品改标题或图片 → 保存 → 发布 → 打开小程序菜单确认约 60 秒内生效。

## 8. 本地验证结果

- `npx prisma validate`：PASS。
- `prisma migrate diff --from-empty --to-schema-datamodel`：新表 SQL 与手写迁移逐项一致（表、索引、外键）。
- `node --test scripts/test-online-catalog-admin.mjs`：10/10 PASS。
- `npm run build`：PASS，生成 `OnlineCatalogPage-*.js`。
- 临时 PostgreSQL 16 实例（端口 55432，非生产）：`prisma migrate deploy` 全部迁移 PASS；`online_categories` / `online_product_profiles` 建表、唯一索引、外键均通过；重复 `mp_id`、缺失 `InventoryItem`、删除有档案的分类均按预期拒绝。
- 真实 Prisma 查询：分类/商品/策略创建、`inventoryItem.is` 关系过滤、`onlineProfile.is null` 过滤、`version increment`、policy upsert/updateMany、P2002/P2003 均 PASS。
- `node scripts/test-online-catalog-api-native.mjs`：真实 HTTP 路由测试 PASS（建分类 → 建 OS 商品+线上档案+policy → 线上价 1300/POS 价 1250 → 列表 → 状态接口 → 发布预览 → 改价 1400/下架 → policy 自动禁用 → 已建档商品不再出现在可选列表 → 重复建档 409）。
- 未执行：真实 CloudBase 发布、浏览器端到端点击。CloudBase 凭据未配置；发布器只用 fake app 做了单元测试。

## 9. 回滚

- 页面/接口：移除 `src/App.jsx` 的 `/online-catalog` 路由或撤下路由挂载即可停止使用；两张表可保留，不影响现有业务。
- 数据库：`online_categories` / `online_product_profiles` 是新增表，不被现有订单/支付路径读取；回滚代码不需要删表。
- CloudBase：发布前导出 `products` 与 `_meta` 快照；需要回滚时按快照恢复对应文档。不要在未备份时批量发布。
- 不要删除 `OnlineProductPolicy` 中现有映射；新商品的 policy 回滚时按 `externalProductId` 精确删除。

## 10. 已知边界

1. 组合商品（`combo`）暂不管理；导入时跳过，需单独设计多 SKU 策略。
2. 分类视觉元数据（颜色）暂无编辑 UI；导入时沿用第一条商品的原 `categoryMeta`，新分类为空对象。
3. 相册/详情图已支持多选上传；分类视觉元数据（颜色）暂无编辑 UI，导入时沿用第一条商品的原 `categoryMeta`，新分类为空对象。
4. 导入按名称精确匹配；重名/改名商品需要手工处理。
5. 没有独立发布审计表；目前只有 `publishedAt / publishedVersion / lastError`。
6. 没有真实 CloudBase 发布回执测试；上线前必须在 TEST 环境或生产快照上做一次无变更发布。
7. 线上价与 POS 价允许不一致；这是有意的，但运营需要知道两套价格。
8. 新建商品默认在 OS 启用（`isActive=true`），草稿也会出现在 POS 商品中心；如不希望，需要后续加“仅线上”开关。
