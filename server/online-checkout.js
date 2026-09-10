import crypto from 'node:crypto'
import { httpError } from './pos-core.js'
import { cents, onlinePaymentAllowed, quoteOnlineCheckout } from './online-checkout-policy.js'
import { onlineFinancialTransaction } from './online-financial-transaction.js'
import { lockSweetCardAccount } from './sweet-card-account-lock.js'
import { sweetCardAvailableBalance } from './sweet-card-available-balance.js'

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const key = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9:_-]{8,128}$/.test(value)) throw httpError('请求标识无效', 400)
  return value
}
function intentOf(input) {
  if (!Array.isArray(input?.lines) || !input.lines.length || input.lines.length > 100) throw httpError('商品选择无效', 400)
  const lines = input.lines.map(x => {
    if (!x || typeof x.productId !== 'string' || !x.productId || x.productId.length > 160
      || typeof x.skuId !== 'string' || !x.skuId || x.skuId.length > 160
      || !Number.isInteger(x.quantity) || x.quantity < 1 || x.quantity > 999) throw httpError('商品选择无效', 400)
    return { productId: x.productId, skuId: x.skuId, quantity: x.quantity }
  })
  if (!['PICKUP', 'DELIVERY'].includes(input.fulfillment)) throw httpError('配送方式无效', 400)
  if (input.fulfillment === 'DELIVERY' && (typeof input.addressRef !== 'string' || !input.addressRef || input.addressRef.length > 160)) throw httpError('配送地址无效', 400)
  if (input.walletRef != null && (typeof input.walletRef !== 'string' || !input.walletRef || input.walletRef.length > 160)) throw httpError('甜意卡选择无效', 400)
  return { lines, fulfillment: input.fulfillment, addressRef: input.fulfillment === 'DELIVERY' ? input.addressRef : null,
    walletRef: input.walletRef || null, desiredSweetCardCents: String(cents(input.desiredSweetCardCents ?? 0)) }
}
async function customer(tx, userId, env, { newPurchase = true } = {}) {
  const user = await tx.user.findUnique({ where: { id: userId } })
  if (!user || user.status !== 'active') throw httpError('请重新登录', 401)
  if (newPurchase && !onlinePaymentAllowed(userId, env)) throw httpError('甜意卡线上支付暂未开放', 403)
  return user
}
async function walletAccount(tx, userId, walletRef, now) {
  const claim = await tx.sweetCardClaim.findUnique({ where: { id: walletRef } })
  if (!claim || claim.userId !== userId) throw httpError('甜意卡不可用', 403)
  await lockSweetCardAccount(tx, claim.accountId)
  const account = await tx.sweetCardAccount.findUnique({ where: { id: claim.accountId }, include: { binding: true, onlinePolicy: true, claim: true } })
  if (!account || account.claim?.id !== walletRef || account.claim.userId !== userId || account.status !== 'ACTIVE'
    || (account.validFrom && account.validFrom > now) || (account.expiresAt && account.expiresAt <= now)
    || account.onlinePolicy?.enabled !== true
    || (account.binding?.userId && account.binding.userId !== userId)
    || (account.bindingMode === 'REQUIRED' && account.binding?.userId !== userId)
    || (account.binding && !account.binding.userId)) throw httpError('甜意卡当前不可用于线上支付', 403)
  return account
}

async function productEligibility(tx, namespace, line) {
  const policy = await tx.onlineProductPolicy.findUnique({ where: { namespace_externalProductId_externalSkuId: {
    namespace, externalProductId: line.productId, externalSkuId: line.skuId,
  } }, include: { product: true } })
  const category = policy?.product?.productCategoryId
  const blocked = category ? await tx.sweetCardCategoryPolicy.findUnique({ where: { categoryId: category } }) : null
  return { canonicalProductId: policy?.productId || null,
    allowed: policy?.enabled === true && policy.product.isActive === true && blocked?.blocked !== true }
}

// resolveCatalog is an INTERNAL server adapter, never a client-supplied envelope.
// It authenticates catalog/address ownership and computes SKU price, discounts,
// shipping, inventory and fulfillment policy from current commerce authority.
// No HTTP routes register until this trusted adapter is wired and certified.
export function createOnlineCheckout(prisma, { resolveCatalog, env = process.env, namespace = 'cloudbase-miniprogram' }) {
  if (typeof resolveCatalog !== 'function') throw Error('ONLINE_CATALOG_AUTHORITY_REQUIRED')
  return {
    async quote(userId, input) {
      const requestKey = key(input.requestKey), intent = intentOf(input)
      const fingerprint = digest(intent), quoteId = `oq-${digest([userId, requestKey])}`
      await customer(prisma, userId, env)
      const replay = await prisma.onlineCheckoutQuote.findUnique({ where: { id: quoteId } })
      if (replay) {
        if (replay.requestFingerprint !== fingerprint) throw httpError('请求标识已用于其他报价', 409)
        return replay
      }
      const catalog = await resolveCatalog({ userId, intent: structuredClone(intent) })
      if (!catalog || !Array.isArray(catalog.lines) || catalog.lines.length !== intent.lines.length) throw httpError('商品报价暂不可用', 409)
      return onlineFinancialTransaction(prisma, quoteId, async tx => {
        await customer(tx, userId, env)
        const prior = await tx.onlineCheckoutQuote.findUnique({ where: { id: quoteId } })
        if (prior) {
          if (prior.requestFingerprint !== fingerprint) throw httpError('请求标识已用于其他报价', 409)
          return prior
        }
        const now = new Date()
        const account = intent.walletRef ? await walletAccount(tx, userId, intent.walletRef, now) : null
        const available = account ? (await sweetCardAvailableBalance(tx, account)).availableCents : 0n
        const lines = []
        for (let i = 0; i < intent.lines.length; i++) {
          const desired = intent.lines[i], line = catalog.lines[i]
          if (line.productId !== desired.productId || line.skuId !== desired.skuId || line.quantity !== desired.quantity) throw httpError('商品报价不匹配', 409)
          const policy = await productEligibility(tx, namespace, line)
          lines.push({ productId: line.productId, skuId: line.skuId, name: line.name, quantity: line.quantity,
            unitPriceCents: line.unitPriceCents, discountCents: line.discountCents,
            onlineEligible: policy.allowed, canonicalProductId: policy.canonicalProductId })
        }
        const snapshot = { ...quoteOnlineCheckout({ lines, shippingCents: catalog.shippingCents, availableCents: available, desiredSweetCardCents: intent.desiredSweetCardCents }),
          accountId: account?.id || null, walletRef: intent.walletRef, fulfillment: intent.fulfillment, addressRef: intent.addressRef, namespace }
        snapshot.lines = snapshot.lines.map((line, i) => ({ ...line, canonicalProductId: lines[i].canonicalProductId }))
        const expiresAt = new Date(Math.min(now.getTime() + 15 * 60000, account?.expiresAt?.getTime() ?? Infinity))
        return tx.onlineCheckoutQuote.create({ data: { id: quoteId, userId, requestKey, requestFingerprint: fingerprint, snapshot, expiresAt } })
      })
    },
    async submit(userId, { quoteId, requestKey: rawKey }) {
      const requestKey = key(rawKey)
      if (typeof quoteId !== 'string' || !quoteId || quoteId.length > 160) throw httpError('报价无效', 400)
      const id = `os-${digest([userId, requestKey])}`, fingerprint = digest({ quoteId })
      try {
        return await onlineFinancialTransaction(prisma, id, async (tx, prior) => {
          await customer(tx, userId, env, { newPurchase: !prior })
          if (prior) {
            if (prior.userId !== userId || prior.requestFingerprint !== fingerprint) throw httpError('请求标识已用于其他订单', 409)
            return prior
          }
          const quote = await tx.onlineCheckoutQuote.findUnique({ where: { id: quoteId } })
          const now = new Date()
          if (!quote || quote.userId !== userId || quote.expiresAt <= now) throw httpError('报价已失效，请重新确认', 409)
          const q = quote.snapshot, sc = cents(q.sweetCardCents), wx = cents(q.wechatCents)
          if (q.namespace !== namespace) throw httpError('报价渠道不匹配', 409)
          let account
          if (sc > 0n) {
            for (const line of q.lines) {
              if (!line.onlineEligible) continue
              const current = await productEligibility(tx, namespace, line)
              if (!current.allowed || current.canonicalProductId !== line.canonicalProductId) throw httpError('商品甜意卡适用规则已变化，请重新确认', 409)
            }
            account = await walletAccount(tx, userId, q.walletRef, now)
            if (account.id !== q.accountId || (await sweetCardAvailableBalance(tx, account)).availableCents < sc) throw httpError('甜意卡可用余额已变化，请重新确认', 409)
          }
          const localPaid = wx === 0n, ledgerId = localPaid ? `scl-${crypto.randomUUID()}` : null
          const row = await tx.onlineSettlement.create({ data: {
            id, userId, quoteId, namespace: q.namespace, externalOrderId: id, requestKey, requestFingerprint: fingerprint,
            accountId: sc > 0n ? account.id : null, status: localPaid ? 'PAID' : 'PENDING', paidAt: localPaid ? now : null,
            currency: q.currency, merchandiseCents: cents(q.merchandiseCents), eligibleMerchandiseCents: cents(q.eligibleMerchandiseCents),
            shippingCents: cents(q.shippingCents), totalCents: cents(q.totalCents), sweetCardCents: sc, wechatCents: wx, expiresAt: quote.expiresAt,
          } })
          if (sc > 0n) {
            await tx.sweetCardReservation.create({ data: { id: `sr-${crypto.randomUUID()}`, settlementId: id, accountId: account.id, userId,
              requestKey: `reserve:${id}`, amountCents: sc, status: localPaid ? 'CAPTURED' : 'RESERVED', capturedAt: localPaid ? now : null, expiresAt: quote.expiresAt } })
            await tx.onlineTender.create({ data: { id: crypto.randomUUID(), settlementId: id, type: 'SWEET_CARD', amountCents: sc,
              status: localPaid ? 'SUCCEEDED' : 'PENDING', verifiedAt: localPaid ? now : null } })
          }
          if (wx > 0n) await tx.onlineTender.create({ data: { id: crypto.randomUUID(), settlementId: id, type: 'WECHAT', amountCents: wx,
            merchantTradeNo: `B${digest(id).slice(0,31)}` } })
          if (localPaid) {
            const balanceAfter = account.balanceCents - sc
            await tx.sweetCardLedger.create({ data: { id: ledgerId, accountId: account.id, type: 'REDEEM', amountCents: -sc,
              balanceAfterCents: balanceAfter, requestKey: `online-capture:${id}`, actorId: userId, metadata: { settlementId: id, channel: 'ONLINE_ORDER' } } })
            await tx.sweetCardAccount.update({ where: { id: account.id }, data: { balanceCents: balanceAfter,
              status: balanceAfter === 0n ? 'EXHAUSTED' : 'ACTIVE', version: { increment: 1 } } })
            // The initial PAID version and capture proof commit with the first event.
            await tx.onlineSettlement.update({ where: { id }, data: { capturedLedgerId: ledgerId } })
          }
          return { ...row, capturedLedgerId: ledgerId }
        })
      } catch (error) {
        if (error?.code === 'P2002') throw httpError('该报价已提交，请查看原订单', 409)
        throw error
      }
    },
  }
}
