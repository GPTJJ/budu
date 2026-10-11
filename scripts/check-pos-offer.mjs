// 仅合成商品／草稿的本功能自查；不加载服务端、数据库或外部接口。
import assert from 'node:assert/strict'
import { normalLineKey, giftLineKey } from '../src/utils/pos.js'
import {
  OFFER_PRODUCTS, buildOfferDraft, cartSignature, createOfferPlan, emptyOfferInput,
  offerPriceSignature, offerRecordMatches, parseOfferInput, persistOfferRecord, solveExact, validateOfferCart,
} from '../src/utils/posOffer.js'

const boxPrices = { long: 4900, square: 4900, twelve: 6900, twentyFour: 12900 }
const products = Object.entries(OFFER_PRODUCTS).map(([role, p]) => ({
  productId: p.id, name: p.label, sku: `synthetic-${role}`, unit: '份', isActive: true,
  salePriceCents: String(p.price ?? boxPrices[role] ?? 500), version: 1, updatedAt: 'synthetic',
}))
const input = (n, boxes = {}) => ({ ...emptyOfferInput(), n: String(n), ...Object.fromEntries(Object.entries(boxes).map(([k, v]) => [k, String(v)])) })
const context = { userId: 'synthetic-user', storeId: 'synthetic-store', draftId: 'synthetic-draft' }
const plan = (kind, n, boxes = {}, catalog = products) => createOfferPlan(kind, input(n, boxes), catalog)
let checks = 0
function check(name, run) { run(); checks += 1; console.log(`PASS ${name}`) }

check('定稿示例及礼盒按现价另计', () => {
  for (const [n, boxes, abc, paidCents, finalB] of [
    [200, {}, [14, 3, 0], 77500n, 260],
    [200, { long: 2, twentyFour: 1 }, [13, 4, 0], 75000n, 267],
    [200, { twelve: 2, twentyFour: 1 }, [14, 1, 3], 74000n, 269],
    [5, {}, [0, 0, 5], 2500n, 6],
  ]) {
    const a = plan('A', n, boxes); const b = plan('B', n, boxes)
    assert.deepEqual([a.a, a.b, a.r], abc)
    assert.equal(a.cents - a.boxCents, paidCents); assert.equal(a.final, n)
    assert.equal(b.final, finalB); assert.equal(b.cents - b.boxCents, BigInt(n) * 500n)
    assert.equal(a.boxCents, b.boxCents)
  }
})
check('精确求解与独立二维穷举 oracle 一致（0–400）', () => {
  for (let t = 0; t <= 400; t += 1) {
    const choices = []
    for (let a = 0; a * 13 <= t; a += 1) for (let b = 0; a * 13 + b * 6 <= t; b += 1) {
      const r = t - 13 * a - 6 * b
      choices.push({ a, b, r, rank: [10 * a + 5 * b + r, r, Number(a > 0) + Number(b > 0) + Number(r > 0), a + b + r, -a] })
    }
    choices.sort((x, y) => { for (let i = 0; i < 5; i += 1) if (x.rank[i] !== y.rank[i]) return x.rank[i] - y.rank[i]; return 0 })
    const got = solveExact(t)
    assert.deepEqual([got.a, got.b, got.r], [choices[0].a, choices[0].b, choices[0].r])
  }
})
check('G=N、G>N、小目标、无效及超大输入', () => {
  const a = plan('A', 5, { twentyFour: 1 }); assert.equal(a.p, 0); assert.equal(a.final, 5)
  assert.throws(() => plan('A', 4, { twentyFour: 1 }), /超过目标/)
  assert.equal(plan('B', 4, { twentyFour: 1 }).final, 9)
  assert.equal(plan('A', 1).p, 1)
  for (const n of ['', '0', '-1', '1.5', 'abc', '9007199254740992']) assert.throws(() => parseOfferInput(input(n)))
  for (const long of ['', '-1', '1.5', 'x']) assert.throws(() => parseOfferInput(input(5, { long })))
  assert.throws(() => plan('A', Number.MAX_SAFE_INTEGER), /上限/)
  assert.throws(() => plan('B', Number.MAX_SAFE_INTEGER), /安全整数/)
  assert.ok(plan('A', 5000).final > 999)
})
check('按各方案依赖核价，缺商品不静默降级', () => {
  const noBox = products.filter((p) => p.productId !== OFFER_PRODUCTS.long.id)
  assert.equal(plan('A', 200, {}, noBox).final, 200)
  assert.throws(() => plan('A', 200, { long: 1 }, noBox), /缺失/)
  const noTen = products.filter((p) => p.productId !== OFFER_PRODUCTS.ten.id)
  assert.throws(() => plan('A', 200, {}, noTen), /缺失/)
  const wrong = products.map((p) => p.productId === OFFER_PRODUCTS.ten.id ? { ...p, salePriceCents: '4900' } : p)
  assert.throws(() => plan('A', 200, {}, wrong), /基线/)
  const renamed = products.map((p) => ({ ...p, name: '改名不改身份' }))
  assert.equal(plan('A', 200, {}, renamed).cents, 77500n)
  const changed = products.map((p) => p.productId === OFFER_PRODUCTS.long.id ? { ...p, salePriceCents: '5100', version: 2 } : p)
  assert.equal(plan('A', 200, { long: 1 }, changed).boxCents, 5100n)
  assert.notEqual(offerPriceSignature(plan('A', 200, { long: 1 }), products), offerPriceSignature(plan('A', 200, { long: 1 }, changed), changed))
  const giftBad = products.map((p) => p.productId === OFFER_PRODUCTS.giftThree.id ? { ...p, isActive: false } : p)
  assert.throws(() => plan('A', 200, {}, giftBad), /不可售/)
})
const extra = { productId: 'synthetic-extra', name: '其他商品', sku: 'synthetic-extra', unit: '份', isActive: true, salePriceCents: '1234' }
const catalog = [...products, extra]
const extraKey = normalLineKey(extra.productId)
const comboKey = `${extraKey}::bb,flavor1,flavor2,flavor3,flavor4`
check('手工接管确认／取消、收费礼盒不追加、保留原始车和口味组合', () => {
  const original = { [normalLineKey(OFFER_PRODUCTS.retail.id)]: 4, [giftLineKey(OFFER_PRODUCTS.giftEight.id)]: 8,
    [normalLineKey(OFFER_PRODUCTS.long.id)]: 2, [giftLineKey(OFFER_PRODUCTS.twentyFour.id)]: 1, [comboKey]: 2 }
  const before = cartSignature(original)
  const draft = buildOfferDraft(original, plan('A', 200, { long: 2 }), catalog, null, context)
  assert.equal(draft.needsConfirmation, true)
  assert.equal(cartSignature(original), before) // 构建后不采用即取消；没有原车副作用。
  assert.equal(draft.cart[normalLineKey(OFFER_PRODUCTS.long.id)], 2)
  assert.equal(draft.cart[giftLineKey(OFFER_PRODUCTS.giftEight.id)], 2)
  assert.equal(draft.cart[giftLineKey(OFFER_PRODUCTS.twentyFour.id)], 1)
  assert.equal(draft.cart[comboKey], 2)
  assert.equal(draft.cart[normalLineKey(OFFER_PRODUCTS.retail.id)], 3)
  assert.equal(draft.chargeable, BigInt(draft.record.planCents) + 2468n)
})
check('零元赠品、重复采用及 A/B 切换不叠加', () => {
  const a = plan('A', 200)
  const first = buildOfferDraft({ [extraKey]: 2 }, a, catalog, null, context)
  assert.equal(first.needsConfirmation, false)
  assert.equal(validateOfferCart(first.cart, catalog), a.cents + 2468n)
  const repeat = buildOfferDraft(first.cart, a, catalog, first.record, context)
  assert.deepEqual(repeat.cart, first.cart); assert.equal(repeat.needsConfirmation, false)
  const b = buildOfferDraft(first.cart, plan('B', 200), catalog, first.record, context)
  assert.equal(b.cart[normalLineKey(OFFER_PRODUCTS.ten.id)], 20)
  assert.equal(b.cart[normalLineKey(OFFER_PRODUCTS.five.id)], undefined)
  assert.equal(b.cart[giftLineKey(OFFER_PRODUCTS.giftThree.id)], 20)
  assert.deepEqual(buildOfferDraft(b.cart, a, catalog, b.record, context).cart, first.cart)
})
check('相关改动失效／无关改动保留／身份草稿隔离／记录损坏缺失', () => {
  const first = buildOfferDraft({ [extraKey]: 2 }, plan('A', 200), catalog, null, context)
  for (const edited of [
    { ...first.cart, [normalLineKey(OFFER_PRODUCTS.ten.id)]: 15 },
    Object.fromEntries(Object.entries(first.cart).filter(([key]) => key !== giftLineKey(OFFER_PRODUCTS.giftThree.id))),
    { ...first.cart, [giftLineKey(OFFER_PRODUCTS.ten.id)]: 1 },
    { ...first.cart, [normalLineKey(OFFER_PRODUCTS.long.id)]: 1 },
  ]) {
    assert.equal(offerRecordMatches(first.record, edited, context), false)
    assert.equal(buildOfferDraft(edited, plan('B', 200), catalog, first.record, context).needsConfirmation, true)
  }
  const unrelated = { ...first.cart, [extraKey]: 3 }
  assert.equal(offerRecordMatches(first.record, unrelated, context), true)
  assert.equal(buildOfferDraft(unrelated, plan('B', 200), catalog, first.record, context).cart[extraKey], 3)
  for (const field of ['userId', 'storeId', 'draftId']) assert.equal(offerRecordMatches(first.record, first.cart, { ...context, [field]: 'other' }), false)
  for (const record of [null, {}, { ...first.record, owned: null }, { ...first.record, owned: {} }, { ...first.record, snapshot: {} }]) assert.equal(offerRecordMatches(record, first.cart, context), false)
  assert.equal(buildOfferDraft(first.cart, plan('A', 200), catalog, null, context).needsConfirmation, true)
})
check('999 份、共享赠品合并、100 行含保留商品、失败原车不变', () => {
  assert.equal(plan('A', 13 * 999).a, 999)
  assert.equal(plan('B', 9990).a, 999)
  assert.throws(() => plan('B', 10000), /999/)
  assert.equal(plan('B', 1, { long: 998, square: 1 }).lines.find((l) => l.role === 'giftEight').quantity, 999)
  assert.throws(() => plan('B', 1, { long: 999, square: 1 }), /999/)
  const extras = Array.from({ length: 99 }, (_, i) => ({ ...extra, productId: `synthetic-${i}` }))
  const rows = [...products, ...extras]
  const keep98 = Object.fromEntries(extras.slice(0, 98).map((p) => [normalLineKey(p.productId), 1]))
  assert.equal(Object.keys(buildOfferDraft(keep98, plan('B', 5), rows, null, context).cart).length, 100)
  const keep99 = { ...keep98, [normalLineKey(extras[98].productId)]: 1 }
  const before = cartSignature(keep99)
  assert.throws(() => buildOfferDraft(keep99, plan('B', 5), rows, null, context), /100/)
  assert.equal(cartSignature(keep99), before)
  assert.throws(() => validateOfferCart({ [extraKey]: 1000 }, catalog), /999/)
  assert.throws(() => validateOfferCart({ 'synthetic-extra::x::bb,a,b,c,d': 1 }, catalog), /格式/)
  assert.throws(() => validateOfferCart({ 'missing::n': 1 }, catalog), /缺失/)
})
check('贡献旁记录保存及存储失败不伪造跨键事务', () => {
  const saved = new Map()
  const storage = { setItem: (key, value) => saved.set(key, value), removeItem: (key) => saved.delete(key) }
  const first = buildOfferDraft({}, plan('A', 200), products, null, context)
  assert.equal(persistOfferRecord(storage, context, first.record), true)
  assert.equal(saved.size, 1)
  assert.equal(persistOfferRecord(storage, context, null), true); assert.equal(saved.size, 0)
  const fail = { setItem() { throw new Error('synthetic-storage-failure') }, removeItem() { throw new Error('synthetic-storage-failure') } }
  assert.equal(persistOfferRecord(fail, context, first.record), false)
  assert.equal(persistOfferRecord(fail, context, null), false)
})
console.log(`PASS ${checks} bounded pure-logic checks; no API / DB / orders / payments`)
