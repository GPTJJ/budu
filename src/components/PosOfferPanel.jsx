import { ArrowLeft } from 'lucide-react'
import { formatCents, parseLineKey } from '../utils/pos'
import { BOX_ROLES, OFFER_PRODUCTS } from '../utils/posOffer'
import styles from './PosOfferPanel.module.css'

function CartDetails({ cart, products, emptyText = '无' }) {
  const byId = new Map(products.map((p) => [p.productId, p]))
  const entries = Object.entries(cart)
  if (!entries.length) return <p className="text-xs text-slate-400">{emptyText}</p>
  return <ul className="space-y-2 text-xs text-slate-600">{entries.map(([key, quantity]) => {
    const { productId, gift } = parseLineKey(key)
    const product = byId.get(productId)
    const combo = key.includes('::bb,') ? '（保留原口味组合）' : ''
    return <li key={key} className="flex min-w-0 justify-between gap-3"><span className="min-w-0 break-words">{product?.name || '当前商品资料缺失'}{combo}<span className={gift ? 'ml-1 text-budu-600' : 'ml-1 text-slate-400'}>{gift ? '赠送' : '收费'}</span></span><span className="shrink-0">{quantity} 份</span></li>
  })}</ul>
}

function PlanCard({ kind, result, offer }) {
  const title = kind === 'A' ? '最低付款方案' : '最多赠糖方案'
  const plan = result?.plan
  return <section className="min-w-0 rounded-2xl border border-budu-100 bg-white p-4">
    <h3 className="font-bold text-slate-800">{kind} · {title}</h3>
    <p className="mt-1 text-xs text-slate-500">{kind === 'A' ? '最终散糖精确等于 N' : '付费散糖为 N，赠糖另加'}</p>
    {result?.error ? <p role="alert" className="mt-4 text-sm text-rose-600">{result.error}</p> : plan && <>
      <p className="mt-4 text-xs text-slate-500">应付活动小计</p>
      <p className="break-words text-2xl font-black text-budu-600">{formatCents(plan.cents)}</p>
      <dl className="mt-3 space-y-1 text-xs text-slate-600">
        {[['付费散糖', `${plan.p} 颗`], ['散糖活动赠糖', `${plan.f} 颗`], ['礼盒赠糖', `${plan.input.g} 颗`], ['最终散糖', `${plan.final} 颗`], ['礼盒金额', formatCents(plan.boxCents)]].map(([label, value]) => <div key={label} className="flex justify-between gap-2"><dt>{label}</dt><dd className="break-all text-right font-semibold">{value}</dd></div>)}
      </dl>
      <ul className="mt-4 space-y-2 border-t border-slate-100 pt-3 text-xs">{plan.lines.map((line) => <li key={line.key} className="min-w-0 text-slate-600"><p className="break-words font-semibold">{line.name} · {line.gift ? '赠送 ¥0.00' : '收费'}</p><p className="mt-0.5 text-slate-400">{line.quantity} 份{line.pieces !== null ? ` = ${line.pieces} 颗散糖` : '礼盒（盒内糖不计入散糖）'}</p></li>)}</ul>
      <button disabled={offer.busy || offer.dirty} onClick={() => offer.apply(kind)} className="mt-4 min-h-11 w-full rounded-xl bg-budu-500 px-2 py-3 text-sm font-bold text-white disabled:bg-slate-200">{offer.busy ? '正在核对…' : `采用${title}`}</button>
    </>}
  </section>
}

export default function PosOfferPanel({ offer }) {
  const outside = offer.quote?.plans.A?.outside || offer.quote?.plans.B?.outside
  return <div className={styles.panel}>
    <button onClick={offer.close} className="mb-4 flex min-h-10 items-center gap-2 text-sm font-semibold text-slate-500"><ArrowLeft className="h-4 w-4" />返回当前订单</button>
    <h3 className="text-lg font-black text-slate-800">优惠试算</h3>
    <p className="mt-1 text-xs leading-5 text-slate-500">仅按当前满赠活动试算，不含额外折扣。N 仅为散糖颗数，礼盒内糖果不计入；礼盒赠糖另计。试算不锁价，结算以服务端金额为准。</p>
    <form onSubmit={(event) => { event.preventDefault(); offer.calculate() }} className="mt-4 space-y-3">
      <label className="block text-sm font-semibold text-slate-700">计划散糖数量 N<input aria-label="计划散糖数量 N" inputMode="numeric" value={offer.input.n} disabled={offer.busy} onChange={(e) => offer.changeInput('n', e.target.value)} placeholder="请输入正整数" className={styles.input} /></label>
      <div className="grid min-w-0 grid-cols-2 gap-3">{BOX_ROLES.map((role) => <label key={role} className="min-w-0 text-xs text-slate-600">{OFFER_PRODUCTS[role].label}<input aria-label={`${OFFER_PRODUCTS[role].label}数量`} inputMode="numeric" value={offer.input[role]} disabled={offer.busy} onChange={(e) => offer.changeInput(role, e.target.value)} className={styles.input} /></label>)}</div>
      <p className="text-xs leading-5 text-slate-400">收费礼盒已带入。已标赠的礼盒保留在计划外，不触发礼盒赠糖。编辑输入不会改变订单。</p>
      <button disabled={offer.busy} className="min-h-11 w-full rounded-xl border border-budu-200 bg-budu-50 px-3 py-2.5 text-sm font-bold text-budu-700 disabled:opacity-50">{offer.busy ? '读取现行商品…' : '计算两方案'}</button>
    </form>
    {offer.message && <p role="status" className="mt-3 rounded-xl bg-amber-50 p-3 text-sm leading-5 text-amber-800">{offer.message}</p>}
    {offer.quote && offer.dirty && <p role="status" className="mt-3 text-xs text-amber-700">输入或订单已变化，请重新计算后采用。</p>}
    {offer.confirmation ? <section className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4">
      <h3 className="font-bold text-slate-800">确认接管相关手工内容</h3>
      <p className="mt-2 text-xs leading-5 text-slate-600">以下收费／赠送行将由本计划完整接管并替换，原数量不再另外保留。其他商品和已标赠礼盒保留；取消保持原车。</p>
      <p className="mb-2 mt-4 text-sm font-bold text-slate-700">替换前</p><CartDetails cart={offer.confirmation.draft.before} products={offer.confirmation.products} />
      <p className="mb-2 mt-4 text-sm font-bold text-slate-700">替换后</p><CartDetails cart={offer.confirmation.draft.after} products={offer.confirmation.products} />
      <div className="mt-5 grid grid-cols-1 gap-2"><button disabled={offer.busy || offer.dirty} onClick={() => offer.apply(offer.confirmation.kind, true)} className="min-h-11 rounded-xl bg-budu-500 px-3 py-3 text-sm font-bold text-white disabled:bg-slate-200">确认接管并采用方案 {offer.confirmation.kind}</button><button disabled={offer.busy} onClick={offer.cancelConfirmation} className="min-h-11 rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm font-semibold text-slate-600">取消，保留原订单</button></div>
    </section> : offer.quote && !offer.dirty && <>
      <p className="mb-3 mt-4 text-xs text-slate-400">现行商品读取：{new Date(offer.quote.readAt).toLocaleTimeString('zh-CN')}；采用前再次核价。</p>
      <div className={styles.plans}>{['A', 'B'].map((kind) => <PlanCard key={kind} kind={kind} result={offer.quote.plans[kind]} offer={offer} />)}</div>
      {outside && Object.keys(outside).length > 0 && <section className="mt-4 rounded-xl bg-slate-50 p-3"><h4 className="mb-3 text-sm font-bold text-slate-700">保留的计划外商品</h4><CartDetails cart={outside} products={offer.quote.products} /><p className="mt-2 text-xs text-slate-400">以上商品不计入本计划散糖颗数与活动小计；原有整单折扣另计。</p></section>}
    </>}
  </div>
}
