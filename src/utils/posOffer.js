import { giftLineKey, normalLineKey, parseLineKey } from './pos.js'

// InventoryItem 稳定 ID；颗数来自已确认活动规则，价格只从现行 POS GET 读取。
export const OFFER_PRODUCTS = {
  retail: { id: 'it-a005da2f-5a59-4f28-9d71-8cf28df6a452', label: '单颗零售', pieces: 1, price: 500 },
  five: { id: 'it-3e30fa9f-c1e6-4d70-b24a-01942e21f8c0', label: '五送一套餐', pieces: 5, price: 2500 },
  ten: { id: 'it-b6f1c6e4-ec92-43b2-9e7f-6b2fc51e2366', label: '十送三套餐', pieces: 10, price: 5000 },
  giftOne: { id: 'it-7bcb83e8-87e7-44a6-9c50-7b96ba126e78', label: '散糖赠品（1 颗）', pieces: 1 },
  giftThree: { id: 'it-f21906bc-84f2-44da-a015-06ec7b356fa0', label: '散糖赠品（3 颗）', pieces: 3 },
  long: { id: 'it-f7b115b9-88f1-42ae-adc4-d58b65eb6a4e', label: '8 颗长款礼盒' },
  square: { id: 'it-37ec32af-d6e9-43e7-9e85-2d36145d9f20', label: '8 颗方款礼盒' },
  twelve: { id: 'it-f2b30d9a-3a28-486e-849f-975ef5363cb0', label: '12 颗礼盒' },
  twentyFour: { id: 'it-msjcvvfl-7azlu5', label: '24 颗礼盒' },
  giftEight: { id: 'it-a55835df-bdc8-4b88-97f4-2080e7de366e', label: '8 颗礼盒赠糖', pieces: 1 },
  giftTwelve: { id: 'it-9cb10762-1935-4c30-b587-7cb3015a2584', label: '12 颗礼盒赠糖', pieces: 2 },
  giftTwentyFour: { id: 'it-a5cae945-48dc-4e8d-b443-da60fe921272', label: '24 颗礼盒赠糖', pieces: 5 },
}
export const BOX_ROLES = ['long', 'square', 'twelve', 'twentyFour']
const boxIds = new Set(BOX_ROLES.map((role) => OFFER_PRODUCTS[role].id))
const relatedIds = new Set(Object.values(OFFER_PRODUCTS).map((p) => p.id))
export const isOfferRelatedKey = (key) => relatedIds.has(parseLineKey(key).productId)
export const emptyOfferInput = () => ({ n: '', long: '0', square: '0', twelve: '0', twentyFour: '0' })
export const cartSignature = (cart) => JSON.stringify(Object.entries(cart || {}).sort(([a], [b]) => a.localeCompare(b)))
export const relatedSnapshot = (cart) => Object.fromEntries(Object.entries(cart || {}).filter(([key]) => relatedIds.has(parseLineKey(key).productId)))
const inScope = (key) => {
  const { productId, gift } = parseLineKey(key)
  return relatedIds.has(productId) && !(boxIds.has(productId) && gift)
}

function integer(value, label, positive = false) {
  const text = String(value ?? '').trim()
  const number = Number(text)
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(number) || number < (positive ? 1 : 0)) {
    throw new Error(`${label}须为安全可表示的${positive ? '正' : '非负'}整数`)
  }
  return number
}

export function parseOfferInput(input) {
  const out = { n: integer(input.n, '计划散糖数量', true) }
  for (const role of BOX_ROLES) out[role] = integer(input[role], OFFER_PRODUCTS[role].label)
  const gifts = BigInt(out.long) + BigInt(out.square) + 2n * BigInt(out.twelve) + 5n * BigInt(out.twentyFour)
  if (gifts > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('礼盒赠糖总数超出安全整数范围')
  return { ...out, g: Number(gifts) }
}

export function prefillOfferBoxes(cart) {
  return Object.fromEntries(BOX_ROLES.map((role) => [role, String(cart?.[normalLineKey(OFFER_PRODUCTS[role].id)] || 0)]))
}

function productFor(role, byId) {
  const rule = OFFER_PRODUCTS[role]
  const product = byId.get(rule.id)
  if (!product || product.isActive !== true || !product.sku || product.unit !== '份') {
    throw new Error(`${rule.label}缺失、不可售或单位不符，不能采用此方案`)
  }
  if (!/^\d+$/.test(String(product.salePriceCents)) || BigInt(product.salePriceCents) > 99999999999n) {
    throw new Error(`${rule.label}价格资料无效`)
  }
  if (rule.price !== undefined && BigInt(product.salePriceCents) !== BigInt(rule.price)) {
    throw new Error(`${rule.label}现价与已确认活动基线不符，不能采用此方案`)
  }
  return product
}

// 最大可执行散糖来自三种收费行各 999 份；先排除不可能执行的输入，枚举最多 1537 次。
// 不把数量约束内的次优解冒充原活动的最优解。
export function solveExact(target) {
  if (!Number.isSafeInteger(target) || target < 0) throw new Error('散糖目标无效')
  if (target > 999 * (13 + 6 + 1)) throw new Error('目标超过现有商品行数量上限可容纳的散糖范围')
  let best = null
  for (let a = 0; a <= Math.floor(target / 13); a += 1) {
    const remaining = target - 13 * a
    const b = Math.floor(remaining / 6)
    const r = remaining % 6
    const p = 10 * a + 5 * b + r
    const rank = [p, r, Number(a > 0) + Number(b > 0) + Number(r > 0), a + b + r, -a]
    if (!best || rank.some((v, i) => v < best.rank[i] && rank.slice(0, i).every((x, j) => x === best.rank[j]))) {
      best = { a, b, r, p, f: 3 * a + b, rank }
    }
  }
  return best
}

export function createOfferPlan(kind, input, products) {
  const parsed = parseOfferInput(input)
  const byId = new Map(products.map((p) => [p.productId, p]))
  let counts
  if (kind === 'A') {
    if (parsed.g > parsed.n) throw new Error('礼盒赠糖已超过目标，无法精确满足；可查看方案 B')
    counts = solveExact(parsed.n - parsed.g)
  } else if (kind === 'B') {
    const a = Math.floor(parsed.n / 10)
    const b = Math.floor((parsed.n % 10) / 5)
    counts = { a, b, r: parsed.n % 5, p: parsed.n, f: 3 * a + b }
  } else throw new Error('未知方案')
  const final = BigInt(counts.p) + BigInt(counts.f) + BigInt(parsed.g)
  if (final > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('最终散糖数量超出安全整数范围')
  const quantities = {
    ten: counts.a, five: counts.b, retail: counts.r, giftThree: counts.a, giftOne: counts.b,
    long: parsed.long, square: parsed.square, twelve: parsed.twelve, twentyFour: parsed.twentyFour,
    giftEight: parsed.long + parsed.square, giftTwelve: parsed.twelve, giftTwentyFour: parsed.twentyFour,
  }
  const lines = []
  let boxCents = 0n
  for (const [role, quantity] of Object.entries(quantities)) {
    if (!quantity) continue
    if (!Number.isSafeInteger(quantity) || quantity > 999) throw new Error(`${OFFER_PRODUCTS[role].label}归并后超过 999 份；不能截断或换成次优方案`)
    const product = productFor(role, byId)
    const gift = role.startsWith('gift')
    if (BOX_ROLES.includes(role)) boxCents += BigInt(product.salePriceCents) * BigInt(quantity)
    lines.push({ role, productId: product.productId, name: product.name, quantity, gift,
      key: gift ? giftLineKey(product.productId) : normalLineKey(product.productId),
      pieces: OFFER_PRODUCTS[role].pieces ? OFFER_PRODUCTS[role].pieces * quantity : null,
      salePriceCents: String(product.salePriceCents), unit: product.unit })
  }
  const cents = 500n * BigInt(counts.p) + boxCents
  const lineCents = lines.reduce((sum, line) => line.gift ? sum : sum + BigInt(line.salePriceCents) * BigInt(line.quantity), 0n)
  const linePieces = lines.reduce((sum, line) => sum + (line.pieces || 0), 0)
  if (lineCents !== cents || linePieces !== Number(final) || (kind === 'A' && Number(final) !== parsed.n)) {
    throw new Error('方案份数、颗数或收费校验失败')
  }
  return { kind, input: parsed, ...counts, final: Number(final), boxCents, cents, lines }
}

export function offerPriceSignature(plan, products) {
  const byId = new Map(products.map((p) => [p.productId, p]))
  return JSON.stringify(plan.lines.map(({ productId }) => {
    const p = byId.get(productId)
    return p ? [productId, p.sku, p.unit, p.isActive, String(p.salePriceCents), p.version ?? null, p.updatedAt ?? null] : [productId, null]
  }))
}

export function validateOfferCart(cart, products) {
  const entries = Object.entries(cart || {})
  if (entries.length < 1 || entries.length > 100) throw new Error('完整订单须为 1–100 行（含保留商品）')
  const byId = new Map(products.map((p) => [p.productId, p]))
  const merged = new Map()
  let chargeable = 0n
  for (const [key, quantity] of entries) {
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 999) throw new Error('完整订单商品数量须为 1–999 份')
    const { productId, gift } = parseLineKey(key)
    const canonical = gift ? giftLineKey(productId) : normalLineKey(productId)
    const combo = key.slice(canonical.length)
    if (key !== canonical && !(key.startsWith(`${canonical}::bb,`) && /^::bb,[^,]+,[^,]+,[^,]+,[^,]+$/.test(combo))) throw new Error('订单存在无法安全核验的行格式，请先在普通订单中核对')
    const product = byId.get(productId)
    if (!product || product.isActive !== true || !product.sku || !/^\d+$/.test(String(product.salePriceCents)) || BigInt(product.salePriceCents) > 99999999999n) {
      throw new Error('完整订单含缺失、停用或价格无效的保留商品；原订单未修改')
    }
    const identity = `${productId}\u0000${gift}\u0000${combo}`
    const total = (merged.get(identity) || 0) + quantity
    if (total > 999) throw new Error('完整订单同一商品／赠送状态／口味组合超过 999 份')
    merged.set(identity, total)
    if (!gift) chargeable += BigInt(product.salePriceCents) * BigInt(quantity)
  }
  return chargeable
}

export function offerRecordMatches(record, cart, context) {
  if (!record || record.schema !== 1 || !['A', 'B'].includes(record.kind) || !record.owned || typeof record.owned !== 'object' || Array.isArray(record.owned) || Object.keys(record.owned).length === 0
    || !record.snapshot || typeof record.snapshot !== 'object' || Array.isArray(record.snapshot) || !Array.isArray(record.takeoverKeys)
    || !/^\d+$/.test(String(record.planCents)) || record.userId !== context.userId || record.storeId !== context.storeId
    || record.draftId !== context.draftId) return false
  const scoped = Object.fromEntries(Object.entries(relatedSnapshot(cart)).filter(([key]) => inScope(key)))
  return Object.entries(record.owned).every(([key, quantity]) => inScope(key) && Number.isSafeInteger(quantity) && quantity > 0 && quantity <= 999)
    && cartSignature(record.owned) === cartSignature(scoped)
    && cartSignature(record.snapshot) === cartSignature(relatedSnapshot(cart))
}

export function buildOfferDraft(cart, plan, products, record, context) {
  const original = { ...cart }
  const scoped = Object.entries(original).filter(([key]) => inScope(key))
  for (const [key] of scoped) {
    const { productId, gift } = parseLineKey(key)
    if (key !== (gift ? giftLineKey(productId) : normalLineKey(productId))) throw new Error('相关商品行格式无法安全接管，请先核对普通订单')
  }
  const verified = offerRecordMatches(record, original, context)
  const next = { ...original }
  for (const [key] of scoped) delete next[key]
  const owned = Object.fromEntries(plan.lines.map((line) => [line.key, line.quantity]))
  Object.assign(next, owned)
  const chargeable = validateOfferCart(next, products)
  const planChargeable = plan.lines.reduce((sum, line) => line.gift ? sum : sum + BigInt(line.salePriceCents) * BigInt(next[line.key]), 0n)
  if (planChargeable !== plan.cents) throw new Error('候选草稿金额与计划不一致')
  return {
    cart: next, chargeable, needsConfirmation: scoped.length > 0 && !verified,
    before: Object.fromEntries(scoped), after: owned,
    outside: Object.fromEntries(Object.entries(next).filter(([key]) => !Object.hasOwn(owned, key))),
    record: { schema: 1, ...context, kind: plan.kind, owned, takeoverKeys: scoped.map(([key]) => key),
      snapshot: relatedSnapshot(next), appliedAt: Date.now(), planCents: String(plan.cents) },
  }
}

const recordKey = (userId, storeId) => `budu-pos:${userId}:${storeId}:offer-contribution`
export function persistOfferRecord(storage, context, record) {
  try {
    if (record) storage.setItem(recordKey(context.userId, context.storeId), JSON.stringify(record))
    else storage.removeItem(recordKey(context.userId, context.storeId))
    return true
  } catch { return false }
}
