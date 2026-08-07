import { useEffect, useState } from 'react'
import { ChevronRight, X } from 'lucide-react'
import Card from './Card'
import { ranking, storeDetails, pctText, storeName, monthLabel } from '../utils/selectors'
import { formatMoney, formatNumber, rankStyle } from '../utils/format'
import { useI18n } from '../i18n'
import { usePublicMode, useStorePrivacy } from '../visibility'

/** 门店经营明细弹窗 */
function StoreModal({ month, store, onClose }) {
  const { t } = useI18n()
  const rows = storeDetails(store)
  const monthMax = new Map()
  for (const r of rows) {
    if (!monthMax.has(r.monthKey) || r.inc > monthMax.get(r.monthKey)) {
      monthMax.set(r.monthKey, r.inc)
    }
  }
  const totalInc = rows.reduce((s, r) => s + r.inc, 0)
  const storeCount = new Set(rows.map((r) => r.key)).size
  const monthCount = new Set(rows.map((r) => r.monthKey)).size

  // Esc 关闭 + 锁定背景滚动
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onClose} />

      <div className="relative flex max-h-[86vh] w-full max-w-5xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl">
        {/* 头部 */}
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-6 py-5">
          <div>
            <h3 className="text-lg font-bold text-slate-800">{t('门店经营明细')}</h3>
            <p className="mt-1 text-xs text-slate-400">
              {t('{store} · 覆盖 {months} 个月 × {stores} 家门店', {
                store: storeName(store),
                months: monthCount,
                stores: storeCount,
              })}
            </p>
          </div>
          <button
            onClick={onClose}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-slate-50 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
            aria-label={t('关闭')}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* 汇总 */}
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-50 px-6 py-3">
          <span className="rounded-lg bg-budu-50 px-2.5 py-1 text-xs font-semibold text-budu-600">
            {t('{count} 家门店', { count: storeCount })}
          </span>
          <span className="rounded-lg bg-grape-50 px-2.5 py-1 text-xs font-semibold text-grape-600">
            {t('{count} 个月', { count: monthCount })}
          </span>
          <span className="rounded-lg bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-600">
            {t('累计营业收入 ¥{amount}', { amount: formatMoney(totalInc) })}
          </span>
        </div>

        {/* 表格 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-2">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white">
              <tr className="border-b border-slate-100 text-left text-[11px] font-medium uppercase tracking-wider text-slate-400">
                <th className="py-3 pr-2">{t('月份')}</th>
                <th className="py-3 pr-2">{t('门店')}</th>
                <th className="py-3 pr-2 text-right">{t('营业收入')}</th>
                <th className="py-3 pr-2 text-right">{t('营业额')}</th>
                <th className="py-3 pr-2 text-right">{t('优惠金额')}</th>
                <th className="py-3 pr-2 text-right">{t('订单量')}</th>
                <th className="py-3 pr-2 text-right">{t('客单价')}</th>
                <th className="py-3 pr-2 text-right">{t('菜品销量')}</th>
                <th className="py-3">{t('环比')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {rows.map((r) => {
                const top = r.inc >= (monthMax.get(r.monthKey) || 0)
                return (
                  <tr key={`${r.monthKey}-${r.key}`} className="transition-colors hover:bg-budu-50/40">
                    <td className="py-2.5 pr-2 font-semibold text-slate-500">{r.month}</td>
                    <td className="py-2.5 pr-2">
                      <div className="flex items-center gap-2">
                        <p className="font-semibold text-slate-700">{r.name}</p>
                        {top && (
                          <span className="rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold text-amber-600">
                            {t('榜首')}
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-[11px] text-slate-400">{r.district}</p>
                    </td>
                    <td className="py-2.5 pr-2 text-right font-semibold tabular-nums text-slate-700">
                      ¥{formatMoney(r.inc)}
                    </td>
                    <td className="py-2.5 pr-2 text-right tabular-nums text-slate-500">
                      ¥{formatMoney(r.rev)}
                    </td>
                    <td className="py-2.5 pr-2 text-right tabular-nums text-slate-500">
                      ¥{formatMoney(r.dis)}
                    </td>
                    <td className="py-2.5 pr-2 text-right tabular-nums text-slate-500">
                      {t('{n} 单', { n: formatNumber(r.ord) })}
                    </td>
                    <td className="py-2.5 pr-2 text-right tabular-nums text-slate-500">
                      ¥{r.avgOrder.toFixed(2)}
                    </td>
                    <td className="py-2.5 pr-2 text-right tabular-nums text-slate-500">
                      {t('{n} 份', { n: formatNumber(r.dish) })}
                    </td>
                    <td className="py-2.5">
                      <span
                        className={`chip ${
                          r.change == null
                            ? 'bg-slate-100 text-slate-400'
                            : r.change >= 0
                              ? 'bg-emerald-50 text-emerald-600'
                              : 'bg-rose-50 text-rose-500'
                        }`}
                      >
                        {r.change == null ? '—' : pctText(r.change)}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <p className="border-t border-slate-50 px-6 py-3 text-[11px] text-slate-300">
          {t('数据来自三店4-7月份报表；「榜首」为该月营业收入最高的门店，环比为较上月营业收入变化。')}
        </p>
      </div>
    </div>
  )
}

export default function StoreRankingTable({ month, store, day }) {
  const { lang, t } = useI18n()
  const isPublic = usePublicMode()
  const isStore = useStorePrivacy()
  const hide = isPublic || isStore
  const [showModal, setShowModal] = useState(false)
  const rows = ranking(month, store, day)
  const single = store !== 'all'

  return (
    <>
      <Card
        title={t('门店经营排行榜')}
        subtitle={
          day
            ? t('{month} · {day} 按日', { month: monthLabel(month, lang), day })
            : t('{month} · 按营业收入排序', { month: monthLabel(month, lang) })
        }
        action={
          !hide && (
          <button
            onClick={() => setShowModal(true)}
            className="flex items-center gap-0.5 text-xs font-medium text-budu-500 transition hover:text-budu-600"
          >
            {t('查看全部')}
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
          )
        }
      >
        {hide ? (
          <div className="grid h-48 place-items-center text-xs text-slate-300">
            {t(isPublic ? '对外展示模式 · 数据已隐藏' : '门店运营模式 · 经营数据已隐藏')}
          </div>
        ) : (
          <div className="-mx-2 overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-[11px] font-medium uppercase tracking-wider text-slate-400">
                <th className="pb-3 pl-2">{t('排名')}</th>
                <th className="pb-3">{t('门店')}</th>
                <th className="pb-3 text-right">{t('营业收入')}</th>
                <th className="pb-3 text-right">{t('客单价')}</th>
                <th className="pb-3 text-right">{t('菜品销量')}</th>
                <th className="pb-3 pr-2 text-right">{t('环比')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {rows.map((row, i) => (
                <tr key={row.key} className="group transition-colors hover:bg-budu-50/40">
                  <td className="py-3 pl-2">
                    <span
                      className={`grid h-6 w-6 place-items-center rounded-lg text-[11px] font-bold text-white ${rankStyle(i)}`}
                    >
                      {i + 1}
                    </span>
                  </td>
                  <td className="py-3">
                    <p className="font-semibold text-slate-700 group-hover:text-budu-600">{row.name}</p>
                    <p className="mt-0.5 text-[11px] text-slate-400">
                      {row.district}
                      {single ? '' : ` · ${t('{n} 单', { n: row.orders })}`}
                    </p>
                  </td>
                  <td className="py-3 text-right font-semibold tabular-nums text-slate-700">
                    ¥{formatMoney(row.income)}
                  </td>
                  <td className="py-3 text-right text-xs tabular-nums text-slate-500">
                    ¥{formatMoney(row.avgOrder)}
                  </td>
                  <td className="py-3 text-right text-xs tabular-nums text-slate-500">
                    {t('{n} 份', { n: formatNumber(row.dish) })}
                  </td>
                  <td className="py-3 pr-2 text-right">
                    <span
                      className={`chip ${
                        row.change == null
                          ? 'bg-slate-100 text-slate-400'
                          : row.change >= 0
                            ? 'bg-emerald-50 text-emerald-600'
                            : 'bg-rose-50 text-rose-500'
                      }`}
                    >
                      {row.change == null ? '—' : pctText(row.change)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </Card>

      {showModal && <StoreModal month={month} store={store} onClose={() => setShowModal(false)} />}
    </>
  )
}
