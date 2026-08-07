# BUDU 加速方案（腾讯云 CDN / 优选流量包）

> 版本：v1.0　日期：2026-08-07
> 现状：正式网址 https://buducandy.cn（腾讯云香港轻量服务器，未 ICP 备案）

## 1. 重要前提：备案限制

腾讯云 CDN / EdgeOne 的**中国大陆节点要求域名已完成 ICP 备案**。
当前 `buducandy.cn` 未备案，因此：

- ❌ 不能开通大陆 CDN 节点（境内加速）
- ✅ 可以开通「轻量优选流量包」（香港 → 大陆线路加速，无需备案）
- ✅ 备案通过后可无缝切换腾讯云 CDN / EdgeOne 大陆节点

## 2. 方案一：轻量优选流量包（推荐，立即生效，无需备案）

这是腾讯云为「香港/新加坡轻量服务器 + 大陆用户」设计的加速产品，
降低时延、减少晚高峰丢包，比境外 CDN 更有效。

开通步骤：
1. 打开 https://console.cloud.tencent.com/lighthouse
2. 进入实例 `lhins-gkqyrkst`（香港）→ 流量包 / 更多 → **轻量优选流量包**
3. 按需购买（一般几十元/月，绑到当前实例）
4. 开启后无需改任何代码/DNS，直接生效

验证：大陆网络多次访问 https://buducandy.cn ，对比开通前后加载时间与稳定性。

## 3. 方案二：备案后套腾讯云 CDN / EdgeOne（大陆节点）

完成 ICP 备案后按以下步骤接入（CDN 与 EdgeOne 二选一，推荐 EdgeOne）：

### 3.1 添加加速域名

- 加速域名：`buducandy.cn`
- 源站类型：自有源站
- 源站地址：`124.156.171.195`
- 回源协议：**HTTPS（443）**，避免回源走 HTTP 再 301 造成循环
- 回源 HOST：`buducandy.cn`

### 3.2 HTTPS 证书

- 上传现有证书（服务器 `deploy/certs/fullchain.pem` + `privkey.pem`），
  或直接在 CDN/EdgeOne 申请免费证书并自动续期。

### 3.3 缓存规则（重要，防止业务数据被缓存）

| 匹配 | 行为 |
| --- | --- |
| 路径 `/api/*` | **不缓存 / 绕过缓存**（动态接口，含登录态与业务数据） |
| 后缀 `.js/.css/.jpg/.png/.svg` | 缓存 1 年（源站已返回 `Cache-Control: immutable`） |
| 路径 `/`（HTML） | 不缓存或按源站 `no-cache` 重新校验 |

> 代码侧已就绪：服务端所有 `/api` 响应已加 `Cache-Control: no-store`，
> 静态资源已加 `public, max-age=31536000, immutable`，CDN 可直接遵循源站头。

### 3.4 切换 DNS

1. 在 CDN/EdgeOne 控制台拿到分配的 **CNAME**（形如 `buducandy.cn.cdn.dnsv1.com`）
2. DNSPod 中把 `buducandy.cn` 的 **A 记录改为 CNAME 记录**，指向该地址
3. 等待生效（一般几分钟到 30 分钟），访问 https://buducandy.cn 验证：
   - 首页可打开、登录正常、数据实时更新（说明 /api 未被缓存）
   - 静态资源响应头带 `age`（命中 CDN 缓存）

### 3.5 回滚

DNSPod 中把 CNAME 改回 A 记录 `124.156.171.195` 即恢复直连，随时可回滚。

## 4. 不建议

- 未备案时套 Cloudflare 等境外 CDN：大陆访问多数反而更慢，且免费版不稳定
- 未备案时用腾讯云 CDN「境外加速」：节点在境外，对大陆用户帮助有限

## 5. 费用参考

- 轻量优选流量包：按流量/套餐计费，一般几十元/月
- 腾讯云 CDN/EdgeOne：按流量或请求量计费，个人站点用量小时通常几元到几十元/月
