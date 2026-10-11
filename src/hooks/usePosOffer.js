import { useEffect, useRef, useState } from 'react'
import { api } from '../utils/api'
import { createCheckoutKey, formatCents } from '../utils/pos'
import {
  buildOfferDraft, cartSignature, createOfferPlan, emptyOfferInput, offerPriceSignature,
  isOfferRelatedKey, offerRecordMatches, persistOfferRecord, prefillOfferBoxes, validateOfferCart,
} from '../utils/posOffer'

const inputSignature = (input) => JSON.stringify(input)
const saveRecord = (context, record) => {
  try { return persistOfferRecord(sessionStorage, context, record) } catch { return false }
}

function quoteFor(input, cart, products, record, context) {
  const plans = {}
  for (const kind of ['A', 'B']) {
    try {
      const plan = createOfferPlan(kind, input, products)
      const draft = buildOfferDraft(cart, plan, products, record, context)
      plans[kind] = { plan, outside: draft.outside, chargeable: draft.chargeable }
    } catch (e) { plans[kind] = { error: e.message } }
  }
  return { inputSignature: inputSignature(input), cartSignature: cartSignature(cart), products, plans, readAt: Date.now() }
}

export default function usePosOffer({ userId, storeId, cart, getCart, setCart, setProducts,
  stage, sessionLoaded, submitting, discountPercent, order, invalidateCheckout }) {
  const [view, setView] = useState(false)
  const [input, setInput] = useState(emptyOfferInput)
  const [quote, setQuote] = useState(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [confirmation, setConfirmation] = useState(null)
  const [record, setRecord] = useState(null)
  const [paymentNotice, setPaymentNotice] = useState('')
  const draftId = useRef(createCheckoutKey())
  const lock = useRef(false)
  const attemptToken = useRef(0)
  const expected = useRef(null)
  const lastOpenedCart = useRef(null)
  const context = { userId, storeId, draftId: draftId.current }
  const latest = useRef(null)
  latest.current = { context, input, quote, record, stage, sessionLoaded, submitting, discountPercent, view }

  const forget = () => {
    saveRecord(latest.current.context, null)
    latest.current.record = null
    setRecord(null)
    expected.current = null
  }

  // 恢复时不信任跨键保存顺序；持久记录仅为草稿旁记录，恢复一律重新确认。
  useEffect(() => {
    draftId.current = createCheckoutKey()
    attemptToken.current += 1
    saveRecord({ userId, storeId }, null)
    setRecord(null)
    expected.current = null
    lastOpenedCart.current = null
    setInput(emptyOfferInput())
    setQuote(null)
    setConfirmation(null)
    setMessage('')
    setPaymentNotice('')
    setView(false)
    return () => {
      draftId.current = createCheckoutKey()
      attemptToken.current += 1
      saveRecord({ userId, storeId }, null)
    }
  }, [userId, storeId])

  useEffect(() => {
    if (record && !offerRecordMatches(record, cart, context)) {
      forget()
      setConfirmation(null)
      setMessage('相关商品已手工改变；下次采用须重新确认接管。')
    }
    if (Object.keys(cart).length === 0 || stage === 'success') {
      forget()
      setConfirmation(null)
      if (stage === 'success') setView(false)
    }
    // 只跟踪相关行；无关商品仍可在同一草稿中编辑。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart, record, stage])

  useEffect(() => {
    if (stage !== 'payment' || !order || !expected.current) return
    const estimate = expected.current
    if (estimate.userId !== userId || estimate.storeId !== storeId || estimate.draftId !== draftId.current || estimate.checkoutKey !== order.checkoutKey) return
    const server = String(order.payableAmount)
    setPaymentNotice(server !== estimate.cents
      ? `当前服务端应收 ${formatCents(server)}，与优惠草稿整单预计 ${formatCents(estimate.cents)} 不同。请核对现价及折扣，再按原流程收款；以服务端金额为准。`
      : '')
  }, [order?.id, order?.payableAmount, stage, userId, storeId])

  const start = () => {
    const current = latest.current
    if (lock.current || !current.view || current.stage !== 'ordering' || !current.sessionLoaded || current.submitting || !current.context.storeId) return null
    lock.current = true
    setBusy(true)
    setMessage('')
    return { ...current, token: attemptToken.current, cart: { ...getCart() }, inputKey: inputSignature(current.input), cartKey: cartSignature(getCart()) }
  }
  const sameScope = (started) => latest.current.context.userId === started.context.userId
    && latest.current.context.storeId === started.context.storeId && draftId.current === started.context.draftId
  const unchanged = (startState) => {
    const current = latest.current
    return sameScope(startState) && current.view && current.stage === 'ordering' && current.sessionLoaded && !current.submitting
      && attemptToken.current === startState.token && inputSignature(current.input) === startState.inputKey
      && current.discountPercent === startState.discountPercent
      && cartSignature(getCart()) === startState.cartKey
  }
  const finish = () => { lock.current = false; setBusy(false) }

  const calculate = async () => {
    const started = start()
    if (!started) return
    setConfirmation(null)
    try {
      const data = await api('/v2/pos/products')
      if (!sameScope(started)) return
      if (!unchanged(started)) throw new Error('输入、门店或草稿已变化，请重新试算；原订单未修改。')
      const rows = Array.isArray(data.rows) ? data.rows : []
      setQuote(quoteFor(started.input, started.cart, rows, started.record, started.context))
      setProducts(rows)
    } catch (e) { if (sameScope(started)) { setQuote(null); setMessage(e.message) } }
    finally { finish() }
  }

  const open = () => {
    const currentCart = getCart()
    const key = cartSignature(currentCart)
    if (lastOpenedCart.current !== key) {
      setInput((current) => ({ ...current, ...prefillOfferBoxes(currentCart) }))
      setQuote(null)
      lastOpenedCart.current = key
    }
    setConfirmation(null)
    setView(true)
  }

  const apply = async (kind, confirmed = false) => {
    // mutex 必须先于第一个 await；确认采用仍重新读取现价。
    const started = start()
    if (!started) return
    try {
      const oldPlan = started.quote?.plans[kind]?.plan
      if (!oldPlan || started.quote.inputSignature !== started.inputKey || started.quote.cartSignature !== started.cartKey) {
        throw new Error('试算已失效，请先重新计算；原订单未修改。')
      }
      const consent = confirmation
      if (confirmed && (!consent || consent.kind !== kind || consent.cartKey !== started.cartKey || consent.inputKey !== started.inputKey)) {
        setConfirmation(null)
        throw new Error('接管明细已变化，请重新试算并确认；原订单未修改。')
      }
      const data = await api('/v2/pos/products')
      if (!sameScope(started)) return
      if (!unchanged(started)) {
        setQuote(null)
        setConfirmation(null)
        throw new Error('核价期间输入、门店或草稿已变化，请重新试算；原订单未修改。')
      }
      const rows = Array.isArray(data.rows) ? data.rows : []
      const refreshed = quoteFor(started.input, started.cart, rows, started.record, started.context)
      const refreshedPlan = refreshed.plans[kind]?.plan
      if (!refreshedPlan) {
        setQuote(refreshed)
        setConfirmation(null)
        throw new Error(refreshed.plans[kind].error)
      }
      if (offerPriceSignature(oldPlan, started.quote.products) !== offerPriceSignature(refreshedPlan, rows)) {
        setQuote(refreshed)
        setProducts(rows)
        setConfirmation(null)
        throw new Error('依赖商品的价格或版本已变化，结果已刷新，请核对后再次主动采用。')
      }
      const draft = buildOfferDraft(started.cart, refreshedPlan, rows, started.record, started.context)
      if (draft.chargeable !== started.quote.plans[kind].chargeable) {
        setQuote(refreshed)
        setProducts(rows)
        setConfirmation(null)
        throw new Error('保留商品现价影响整单金额，结果已刷新，请核对后再次采用。')
      }
      if (draft.needsConfirmation && !confirmed) {
        setConfirmation({ kind, cartKey: started.cartKey, inputKey: started.inputKey, draft, products: rows })
        return
      }
      // 下面没有 await，也没有逐行加购；一次替换完整且已验证的草稿。
      invalidateCheckout()
      setCart(draft.cart)
      setProducts(rows)
      setQuote(quoteFor(started.input, draft.cart, rows, draft.record, started.context))
      const saved = saveRecord(started.context, draft.record)
      setRecord(saved ? draft.record : null)
      expected.current = null
      setConfirmation(null)
      setMessage(saved ? `已采用方案 ${kind}：本计划 ${refreshedPlan.final} 颗散糖；其他商品、备注和折扣保留。`
        : '草稿已采用，但贡献记录保存失败；再次采用将按来源未明重新确认。')
      setView(false)
      lastOpenedCart.current = cartSignature(draft.cart)
    } catch (e) { if (sameScope(started)) setMessage(e.message) }
    finally { finish() }
  }

  return { view, input, quote, busy, message, confirmation, paymentNotice,
    dirty: !quote || quote.inputSignature !== inputSignature(input) || quote.cartSignature !== cartSignature(cart),
    open, close: () => { attemptToken.current += 1; setView(false); setConfirmation(null) }, calculate, apply,
    changeInput: (key, value) => { setInput((current) => ({ ...current, [key]: value })); setConfirmation(null) },
    cancelConfirmation: () => { setConfirmation(null); setMessage('已取消接管，原订单保持不变。') },
    cartEdited: (key) => {
      if (!isOfferRelatedKey(key)) return
      attemptToken.current += 1
      forget()
      setConfirmation(null)
    },
    cartStorageFailed: () => {
      forget()
      setConfirmation(null)
      setMessage('订单草稿会话保存失败，当前页面保留原内容；刷新后可能无法恢复。优惠贡献已失效，下次采用须重新确认接管。')
    },
    prepareCheckout: (checkoutKey) => {
      expected.current = null
      setPaymentNotice('')
      const current = latest.current
      if (!current.quote || !offerRecordMatches(current.record, getCart(), current.context)) return
      try {
        const subtotal = validateOfferCart(getCart(), current.quote.products)
        expected.current = { ...current.context, checkoutKey,
          cents: String((subtotal * BigInt(current.discountPercent) + 50n) / 100n) }
      } catch { /* 仅提示差异，不介入原结算逻辑 */ }
    },
    resetDraft: () => { draftId.current = createCheckoutKey(); forget(); setQuote(null); setConfirmation(null); setView(false); setMessage(''); setPaymentNotice(''); lastOpenedCart.current = null },
  }
}
