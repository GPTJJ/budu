import { useEffect, useState } from 'react'
import { ChevronRight, X } from 'lucide-react'
import Card from './Card'
import { products, storeName, monthLabel } from '../utils/selectors'
import { formatMoney, formatNumber } from '../utils/format'
import { useI18n } from '../i18n'
import { usePublicMode, useStorePrivacy } from '../visibility'
import { getProductImages } from '../utils/userData'

// 菜品名称 -> 缩略图 emoji 映射
const EMOJI_RULES = [
  [/冰淇淋/g, '🍦'],
  [/生巧/g, '🍫'],
  [/抹茶/g, '🍵'],
  [/茉莉/g, '🍵'],
  [/泰式奶茶/g, '🧋'],
  [/奶茶/g, '🧋'],
  [/柠檬/g, '🍋'],
  [/橙子/g, '🍊'],
  [/柚子/g, '🍊'],
  [/百香果/g, '🍈'],
  [/树莓/g, '🍓'],
  [/草莓/g, '🍓'],
  [/香草/g, '🍦'],
  [/伯爵/g, '🫖'],
  [/海盐焦糖/g, '🍮'],
  [/焦糖/g, '🍮'],
  [/榛子/g, '🌰'],
  [/咖啡/g, '☕'],
  [/马卡龙/g, '🍥'],
  [/泡芙/g, '🧁'],
  [/蛋糕/g, '🍰'],
  [/大福/g, '🍡'],
  [/筒/g, '🍦'],
  [/球/g, '🍦'],
  [/颗/g, '🍬'],
  [/装/g, '🍬'],
  [/口味/g, '🍬'],
]

function emojiFor(name) {
  for (const [re, em] of EMOJI_RULES) {
    if (re.test(name)) return em
  }
  return '🍰'
}

const THUMB_BG = [
  'bg-budu-50',
  'bg-grape-50',
  'bg-rose-50',
  'bg-amber-50',
  'bg-orange-50',
  'bg-emerald-50',
  'bg-sky-50',
  'bg-violet-50',
  'bg-teal-50',
  'bg-indigo-50',
]

const isGiftLike = (name) => /赠品|临时商品/.test(name)

/** 商品销售明细弹窗 */
function ProductModal({ month, store, onClose, onOpenProduct }) {
  const { lang, t } = useI18n()
  const [showGift, setShowGift] = useState(false)
  const images = getProductImages()
  const all = products(month, store)
  const list = showGift ? all : all.filter((p) => !isGiftLike(p.name))
  const totalAmount = list.reduce((s, p) => s + p.amount, 0)
  const maxAmount = list[0]?.amount || 1

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
      {/* 遮罩 */}
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onClose} />

      {/* 弹窗 */}
      <div className="relative flex max-h-[86vh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl">
        {/* 头部 */}
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-6 py-5">
          <div>
            <h3 className="text-lg font-bold text-slate-800">{t('商品销售明细')}</h3>
            <p className="mt-1 text-xs text-slate-400">
              {t('{month} · {store} · 按销售额排序', {
                month: monthLabel(month, lang),
                store: storeName(store),
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

        {/* 汇总 + 切换 */}
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-50 px-6 py-3">
          <span className="rounded-lg bg-budu-50 px-2.5 py-1 text-xs font-semibold text-budu-600">
            {t('{count} 个菜品', { count: list.length })}
          </span>
          <span className="rounded-lg bg-grape-50 px-2.5 py-1 text-xs font-semibold text-grape-600">
            {t('总销量 {n} 份', {
              n: formatNumber(Math.round(list.reduce((s, p) => s + p.sales, 0))),
            })}
          </span>
          <span className="rounded-lg bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-600">
            {t('总销售额 ¥{amount}', { amount: formatMoney(totalAmount) })}
          </span>
          <label className="ml-auto flex cursor-pointer select-none items-center gap-2 text-xs font-medium text-slate-500">
            <span
              role="switch"
              aria-checked={showGift}
              onClick={() => setShowGift((v) => !v)}
              className={`relative h-5 w-9 rounded-full transition-colors ${showGift ? 'bg-budu-400' : 'bg-slate-200'}`}
            >
              <span
                className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${showGift ? 'left-[18px]' : 'left-0.5'}`}
              />
            </span>
            {t('显示赠品 / 临时商品')}
          </label>
        </div>

        {/* 表格 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-2">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white">
              <tr className="border-b border-slate-100 text-left text-[11px] font-medium uppercase tracking-wider text-slate-400">
                <th className="py-3 pr-2">{t('排名')}</th>
                <th className="py-3 pr-2">{t('商品')}</th>
                <th className="py-3 pr-2 text-right">{t('销量')}</th>
                <th className="py-3 pr-2 text-right">{t('销售额')}</th>
                <th className="py-3 pr-2 text-right">{t('收入')}</th>
                <th className="py-3 pr-2 text-right">{t('优惠')}</th>
                <th className="py-3">{t('销售额占比')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {list.map((row, i) => (
                <tr key={row.name} className="transition-colors hover:bg-budu-50/40">
                  <td className="py-2.5 pr-2 text-xs font-bold text-slate-400">{i + 1}</td>
                  <td className="py-2.5 pr-2">
                    <div className="flex items-center gap-2.5">
                      <div
                        className={`grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-xl text-base ${THUMB_BG[i % THUMB_BG.length]}`}
                      >
                        {images[row.name] ? (
                          <img src={images[row.name]} alt="" className="h-full w-full object-cover" />
                        ) : (
                          emojiFor(row.name)
                        )}
                      </div>
                      <button
                        onClick={() => onOpenProduct && onOpenProduct(row.name)}
                        className="font-semibold text-slate-700 transition hover:text-budu-600"
                      >
                        {row.name}
                      </button>
                    </div>
                  </td>
                  <td className="py-2.5 pr-2 text-right tabular-nums text-slate-500">
                    {t('{n} 份', { n: formatNumber(Math.round(row.sales)) })}
                  </td>
                  <td className="py-2.5 pr-2 text-right font-semibold tabular-nums text-slate-700">
                    ¥{formatMoney(row.amount)}
                  </td>
                  <td className="py-2.5 pr-2 text-right tabular-nums text-slate-500">
                    ¥{formatMoney(row.income)}
                  </td>
                  <td className="py-2.5 pr-2 text-right tabular-nums text-slate-500">
                    ¥{formatMoney(row.discount)}
                  </td>
                  <td className="py-2.5">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-100">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-budu-400 to-grape-500"
                          style={{ width: `${(row.amount / maxAmount) * 100}%` }}
                        />
                      </div>
                      <span className="text-[11px] tabular-nums text-slate-400">
                        {totalAmount ? ((row.amount / totalAmount) * 100).toFixed(1) : '0.0'}%
                      </span>
                    </div>
                  </td>
                </tr>
              ))}
              {list.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-sm text-slate-300">
                    {t('该月份暂无菜品销售数据')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="border-t border-slate-50 px-6 py-3 text-[11px] text-slate-300">
          {t('数据来自三店菜品明细报表；默认隐藏「赠品 / 临时商品」类目，可通过上方开关查看全量数据。')}
        </p>
      </div>
    </div>
  )
}

export default function ProductSalesTable({ month, store, onOpenProduct }) {
  const { lang, t } = useI18n()
  const isPublic = usePublicMode()
  const isStore = useStorePrivacy()
  const hide = isPublic || isStore
  const images = getProductImages()
  const [showModal, setShowModal] = useState(false)
  const all = products(month, store)
  const visible = all.filter((p) => !isGiftLike(p.name))
  const rows = visible.slice(0, 10)
  const summary = visible.reduce(
    (s, p) => {
      s.count += 1
      s.sales += p.sales
      s.amount += p.amount
      s.income += p.income
      s.discount += p.discount
      return s
    },
    { count: 0, sales: 0, amount: 0, income: 0, discount: 0 },
  )
  const maxAmount = rows[0]?.amount || 1

  return (
    <>
      <Card
        title={t('商品销售 TOP10')}
        subtitle={t('{month} · {store} · 按销售额排序', {
          month: monthLabel(month, lang),
          store: storeName(store),
        })}
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
          <>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="rounded-lg bg-budu-50 px-2.5 py-1 text-xs font-semibold text-budu-600">
            {t('{count} 个菜品', { count: summary.count })}
          </span>
          <span className="rounded-lg bg-grape-50 px-2.5 py-1 text-xs font-semibold text-grape-600">
            {t('总销量 {n} 份', { n: formatNumber(Math.round(summary.sales)) })}
          </span>
          <span className="rounded-lg bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-600">
            {t('总销售额 ¥{amount}', { amount: formatMoney(summary.amount) })}
          </span>
        </div>

        <div className="-mx-2 overflow-x-auto">
          <table className="w-full min-w-[480px] text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-[11px] font-medium uppercase tracking-wider text-slate-400">
                <th className="pb-3 pl-2">{t('商品')}</th>
                <th className="pb-3 text-right">{t('销量')}</th>
                <th className="pb-3 text-right">{t('销售额')}</th>
                <th className="pb-3 pr-2">{t('销售额占比')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {rows.map((row, i) => (
                <tr key={row.name} className="group transition-colors hover:bg-budu-50/40">
                  <td className="py-2.5 pl-2">
                    <div className="flex items-center gap-3">
                      <div
                        className={`grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-xl text-lg ${THUMB_BG[i % THUMB_BG.length]}`}
                      >
                        {images[row.name] ? (
                          <img src={images[row.name]} alt="" className="h-full w-full object-cover" />
                        ) : (
                          emojiFor(row.name)
                        )}
                      </div>
                      <div className="min-w-0 leading-tight">
                        <button
                          onClick={() => onOpenProduct && onOpenProduct(row.name)}
                          className="block max-w-full truncate font-semibold text-slate-700 transition group-hover:text-budu-600"
                        >
                          {row.name}
                        </button>
                        <p className="mt-0.5 text-[11px] text-slate-400">
                          {t('收入 ¥{income} · 优惠 ¥{discount}', {
                            income: formatMoney(row.income),
                            discount: formatMoney(row.discount),
                          })}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="py-2.5 text-right tabular-nums text-slate-500">
                    {t('{n} 份', { n: formatNumber(Math.round(row.sales)) })}
                  </td>
                  <td className="py-2.5 text-right font-semibold tabular-nums text-slate-700">
                    ¥{formatMoney(row.amount)}
                  </td>
                  <td className="py-2.5 pr-2">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-100">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-budu-400 to-grape-500"
                          style={{ width: `${(row.amount / maxAmount) * 100}%` }}
                        />
                      </div>
                      <span className="text-[11px] tabular-nums text-slate-400">
                        {((row.amount / summary.amount) * 100).toFixed(1)}%
                      </span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-[11px] leading-4 text-slate-300">
          {t('数据来自三店菜品明细报表；已剔除「赠品 / 临时商品」类目，点击「查看全部」可查看完整明细。')}
        </p>
          </>
        )}
      </Card>

      {showModal && (
        <ProductModal
          month={month}
          store={store}
          onClose={() => setShowModal(false)}
          onOpenProduct={onOpenProduct}
        />
      )}
    </>
  )
}
