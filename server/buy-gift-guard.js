/**
 * 买赠规则版本保护：旧版 v1 面板 vs 小程序 v2 多品类规则。
 *
 * CloudBase `promotions/buy_gift` 同一份文档有两个读写方：
 *  - 本仓库旧版面板 GET/PUT `/api/v2/online-catalog/buy-gift`，写 **v1** 结构：
 *    `{ active, triggerType, triggerCategory, triggerProductIds, tiers[], startAt, endAt }`
 *  - 小程序 `orders` / `payOrder` 的 `buy-gift.js` 读同一文档，**v2** 结构为 `{ active, rules[] }`，
 *    支持多品类同时触发、散糖按档累计、礼盒按盒规格赠糖、生巧形态二选一。
 *
 * 旧面板保存是**整文档覆盖**：线上一旦是 v2，保存会把 `rules[]` 冲掉，
 * 顾客侧静默退回「单分类 + 最高档一次」。小程序侧已于 2026-11-24 移除自愈升级，
 * 覆盖之后不会再有任何机制把文档恢复成 v2。
 *
 * 因此：v2 文档对面板只读；PUT 必须在写入前重读并按 `buyGiftWriteDecision` 拒绝。
 */

/** 与小程序侧口径一致：只要带 rules 数组（含空数组）即视为 v2 */
export function isV2BuyGiftDoc(doc) {
  return !!(doc && Array.isArray(doc.rules))
}

export const BUY_GIFT_V2_READ_ONLY_REASON =
  '线上已升级为 v2 多品类买赠规则（rules[]）。本面板是旧版「单分类 + 最高档一次」编辑器，保存会整份覆盖并冲掉 v2 规则，已切换为只读；请使用新版 v2 规则配置。'

/**
 * 写前裁决。`existing` 为写入前重新读到的文档（null = 文档不存在）。
 * 返回 { allow, status, code, message }，路由据此抛 httpError，绝不静默放行。
 */
export function buyGiftWriteDecision(existing) {
  if (isV2BuyGiftDoc(existing)) {
    return {
      allow: false,
      status: 409,
      code: 'BUY_GIFT_V2_READ_ONLY',
      message: '线上已是 v2 多品类买赠规则，旧版面板不能保存。请使用新版 v2 规则配置，避免把 rules[] 覆盖回单分类档位。',
    }
  }
  return { allow: true, status: 200, code: 'OK', message: '' }
}

/** 面板展示用：v2 文档只暴露只读摘要，不回填到 v1 表单里让人误以为可编辑 */
export function buyGiftV2Summary(doc) {
  if (!isV2BuyGiftDoc(doc)) return null
  return {
    active: !!doc.active,
    startAt: doc.startAt == null ? null : Number(doc.startAt),
    endAt: doc.endAt == null ? null : Number(doc.endAt),
    rules: doc.rules.map((rule) => ({
      id: String(rule && rule.id || ''),
      label: String(rule && rule.label || ''),
      category: rule && rule.category,
      mode: String(rule && rule.mode || ''),
    })),
  }
}
