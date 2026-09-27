import { Package, RotateCcw, X } from 'lucide-react'
import { OverlayHeader, OverlayPanel, OverlayScrollRegion, OverlayViewport } from './overlay/OverlayPrimitives'
import {
  formatReportCents,
  localReportTime,
  orderSourceText,
  orderStatusText,
  settlementText,
} from '../utils/reportCenterUi'
import { entryModeLabel, isExternalOrder } from '../utils/reportCenterPos'

function valueOf(object, ...keys) {
  for (const key of keys) {
    if (object?.[key] !== undefined && object?.[key] !== null) return object[key]
  }
  return null
}

function refundAmount(refund) {
  return valueOf(refund, 'refundCents', 'amount', 'refundAmount')
}

/** Shared, read-only order fact presentation used by POS and Report Center. */
export default function OrderDetailSheet({ order, onClose, actions = null, onQueryRefund = null }) {
  if (!order) return null
  const payable = valueOf(order, 'payableCents', 'payableAmount')
  const refunds = order.refunds || []
  const refunded = refunds
    .filter((refund) => !refund.status || refund.status === 'completed')
    .reduce((sum, refund) => sum + BigInt(refundAmount(refund) || 0), 0n)
  const settlementType = order.settlementType || (isExternalOrder(order) ? 'PLATFORM' : String(order.paymentMethod || order.payments?.[0]?.channel || '').toUpperCase())

  return (
    <OverlayViewport className="fixed inset-0 z-[90] grid place-items-center bg-slate-900/45 p-0 backdrop-blur-sm sm:p-4" role="dialog" aria-modal="true" aria-label="订单明细">
      <OverlayPanel className="flex h-full min-h-0 w-full max-w-3xl flex-col overflow-hidden bg-white shadow-2xl sm:my-6 sm:h-auto sm:max-h-[calc(100dvh-3rem)] sm:rounded-3xl">
        <OverlayHeader className="flex items-center border-b border-slate-100 bg-white px-4 py-4 sm:px-6">
          <div className="min-w-0">
            <h3 className="text-lg font-bold text-slate-900">订单明细</h3>
            <p className="mt-0.5 truncate font-mono text-xs text-slate-400">{order.orderNo}</p>
          </div>
          <button type="button" onClick={onClose} className="ml-auto grid h-11 w-11 shrink-0 place-items-center rounded-xl text-slate-400 transition hover:bg-slate-100 active:scale-95" aria-label="关闭">
            <X className="h-5 w-5" />
          </button>
        </OverlayHeader>

        <OverlayScrollRegion className="grid gap-5 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:p-6">
          <div className="grid grid-cols-2 gap-3 rounded-2xl border border-slate-100 bg-slate-50 p-4 text-sm sm:grid-cols-4">
            <div><p className="text-xs text-slate-400">门店</p><p className="mt-1 font-semibold text-slate-700">{order.storeName || order.storeKey}</p></div>
            <div><p className="text-xs text-slate-400">收银员</p><p className="mt-1 font-semibold text-slate-700">{order.cashierNameSnapshot || '—'}</p></div>
            <div><p className="text-xs text-slate-400">下单时间</p><p className="mt-1 font-semibold text-slate-700">{localReportTime(order.createdAt)}</p></div>
            <div><p className="text-xs text-slate-400">状态</p><p className="mt-1 font-semibold text-slate-700">{orderStatusText(order.status)}</p></div>
          </div>

          <div className="grid grid-cols-1 gap-3 rounded-2xl border border-slate-100 p-4 text-sm sm:grid-cols-3">
            <div><p className="text-xs text-slate-400">订单来源</p><p className="mt-1 font-semibold text-slate-700">{orderSourceText(order.orderSource)}</p></div>
            <div><p className="text-xs text-slate-400">结算</p><p className="mt-1 font-semibold text-slate-700">{settlementText(settlementType)}</p></div>
            <div><p className="text-xs text-slate-400">录入</p><p className="mt-1 font-semibold text-slate-700">{entryModeLabel(order.entryMode)}</p></div>
          </div>

          {isExternalOrder(order) && (
            <div className="rounded-2xl border border-violet-100 bg-violet-50/60 px-4 py-3 text-sm text-violet-800">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <strong>平台结算</strong>
                <span>{formatReportCents(valueOf(order.externalSettlement, 'amountCents') ?? valueOf(order, 'settlementCents'))}</span>
                <span className="text-xs">{orderStatusText(order.status)}</span>
              </div>
              {refunded > 0n && <p className="mt-2 text-xs">已退款 {formatReportCents(refunded)} · 剩余有效收入 {formatReportCents(BigInt(payable || 0) - refunded)}</p>}
            </div>
          )}

          <section>
            <h4 className="flex items-center gap-2 text-sm font-bold text-slate-800"><Package className="h-4 w-4 text-budu-500" />商品明细</h4>
            <div className="mt-2 overflow-hidden rounded-2xl border border-slate-100">
              <table className="block w-full text-left text-sm sm:table">
                <thead className="hidden bg-slate-50/80 text-xs font-semibold text-slate-400 sm:table-header-group"><tr><th className="px-4 py-2.5">商品</th><th className="px-4 py-2.5">SKU</th><th className="px-4 py-2.5 text-right">单价</th><th className="px-4 py-2.5 text-right">数量</th><th className="px-4 py-2.5 text-right">小计</th></tr></thead>
                <tbody className="block divide-y divide-slate-100 sm:table-row-group">
                  {(order.items || []).map((item) => (
                    <tr key={item.id} className="grid grid-cols-[1fr_auto] gap-x-3 px-4 py-3 sm:table-row sm:p-0">
                      <td className="font-semibold text-slate-700 sm:table-cell sm:px-4 sm:py-2.5">{item.productNameSnapshot}{item.isGift && <span className="ml-1.5 rounded-full bg-rose-50 px-1.5 py-0.5 text-[10px] font-bold text-rose-500">赠送</span>}</td>
                      <td className="row-start-2 font-mono text-[11px] text-slate-400 sm:table-cell sm:px-4 sm:py-2.5 sm:text-xs">{item.skuSnapshot || '—'}</td>
                      <td className="hidden text-right tabular-nums text-slate-600 sm:table-cell sm:px-4 sm:py-2.5">{item.isGift ? '¥0.00' : formatReportCents(valueOf(item, 'unitPriceCents', 'unitPrice'))}</td>
                      <td className="row-start-2 text-right text-xs tabular-nums text-slate-500 sm:table-cell sm:px-4 sm:py-2.5 sm:text-sm">× {item.quantity}</td>
                      <td className="col-start-2 row-start-1 text-right font-bold tabular-nums text-slate-800 sm:table-cell sm:px-4 sm:py-2.5 sm:font-semibold">{item.isGift ? '¥0.00' : formatReportCents(valueOf(item, 'actualCents', 'lineAmount'))}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="block border-t border-slate-100 bg-slate-50/60 text-sm font-bold text-slate-800 sm:table-footer-group"><tr className="flex items-center justify-between sm:table-row"><td colSpan="4" className="px-4 py-3 text-right">结算金额</td><td className="px-4 py-3 text-right text-lg tabular-nums text-budu-700 sm:text-sm">{formatReportCents(valueOf(order, 'settlementCents', 'payableAmount'))}</td></tr></tfoot>
              </table>
            </div>
          </section>

          {(order.payments || []).length > 0 && (
            <section>
              <h4 className="text-sm font-bold text-slate-800">支付记录</h4>
              <div className="mt-2 space-y-2">
                {order.payments.map((payment) => (
                  <div key={payment.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-slate-100 bg-slate-50 px-4 py-2.5 text-sm">
                    <span className="font-mono text-xs font-semibold text-slate-600">{payment.paymentNo || payment.id}</span>
                    <span className="rounded-full bg-budu-50 px-2 py-0.5 text-xs font-semibold text-budu-600">{settlementText(String(payment.channel || '').toUpperCase())}</span>
                    <span className="font-semibold tabular-nums text-slate-700">{formatReportCents(payment.amount)}</span>
                    <span className="text-xs text-emerald-600">{payment.status === 'success' ? '支付成功' : payment.status}</span>
                    <span className="ml-auto text-xs text-slate-400">{localReportTime(payment.paidAt || payment.createdAt)}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {refunds.length > 0 && (
            <section>
              <h4 className="flex items-center gap-2 text-sm font-bold text-slate-800"><RotateCcw className="h-4 w-4 text-orange-500" />退款记录</h4>
              <div className="mt-2 space-y-2">
                {refunds.map((refund) => (
                  <div key={refund.id} className="rounded-xl border border-orange-100 bg-orange-50/60 px-4 py-3 text-sm">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                      <span className="font-mono text-xs font-semibold text-slate-600">{refund.refundNo || refund.id}</span>
                      <span className="font-semibold tabular-nums text-orange-700">-{formatReportCents(refundAmount(refund))}</span>
                      <span className="text-xs text-slate-500">{refund.status === 'pending' ? '退款处理中' : refund.status === 'failed' ? '退款异常' : '已退款'}</span>
                      <span className="ml-auto text-xs text-slate-400">{localReportTime(refund.externalCompletedAt || refund.completedAt || refund.createdAt)}</span>
                      {refund.status === 'pending' && typeof onQueryRefund === 'function' && <button type="button" onClick={() => onQueryRefund(refund)} className="rounded-lg border border-amber-200 bg-white px-2.5 py-1 text-xs font-semibold text-amber-700">查询退款结果</button>}
                    </div>
                    <p className="mt-1 text-xs text-slate-500">{refund.refundMode === 'MANUAL_EXTERNAL' ? '平台已完成 · budu 人工记录' : '店内支付退款'}</p>
                    {refund.reason && <p className="mt-1 text-xs text-slate-500">原因：{refund.reason}</p>}
                    {(refund.items || []).length > 0 && <p className="mt-1 text-xs text-slate-500">{refund.items.map((item) => `${item.productName || '商品'}×${item.quantity}`).join('、')}</p>}
                  </div>
                ))}
              </div>
            </section>
          )}

          <footer className="sticky bottom-0 -mx-4 flex flex-col-reverse gap-2 border-t border-slate-100 bg-white/95 px-4 pb-[max(0px,env(safe-area-inset-bottom))] pt-4 backdrop-blur sm:-mx-6 sm:flex-row sm:justify-end sm:px-6">
            {actions}
            <button type="button" onClick={onClose} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-600"><X className="h-4 w-4" />完成</button>
          </footer>
        </OverlayScrollRegion>
      </OverlayPanel>
    </OverlayViewport>
  )
}
