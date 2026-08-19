import {
  TrendingUp,
  ShoppingBag,
  Wallet,
  UtensilsCrossed,
  BadgePercent,
  CalendarCheck2,
} from 'lucide-react'
import { pctText } from '../utils/selectors'
import { useI18n } from '../i18n'
import { usePublicMode, useStorePrivacy } from '../visibility'

const CARD_STYLE = {
  income: { label: '营业收入', iconBg: 'bg-budu-500', color: '#BC4F7E', icon: TrendingUp },
  orders: { label: '订单数', iconBg: 'bg-slate-500', color: '#64748B', icon: ShoppingBag },
  avgOrder: { label: '客单价', iconBg: 'bg-amber-500', color: '#D97706', icon: Wallet },
  dish: { label: '菜品销量', iconBg: 'bg-emerald-500', color: '#059669', icon: UtensilsCrossed },
  discount: { label: '优惠金额', iconBg: 'bg-sky-500', color: '#0284C7', icon: BadgePercent },
  dailyAvg: { label: '日均营业额', iconBg: 'bg-violet-500', color: '#7C3AED', icon: CalendarCheck2 },
}

export default function KpiCard({ card, featured = false }) {
  const { t } = useI18n()
  const isPublic = usePublicMode()
  const isStore = useStorePrivacy()
  const hide = isPublic || isStore
  const style = CARD_STYLE[card.key] || CARD_STYLE.income
  const Icon = style.icon
  const spark = Array.isArray(card.spark) ? card.spark : []
  const up = card.change == null ? null : card.change >= 0

  return (
    <div
      className={`card group min-w-0 p-3.5 transition duration-300 hover:-translate-y-0.5 hover:shadow-card-hover sm:p-5 ${
        featured ? 'col-span-2 xl:col-span-1' : ''
      }`}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <div
          className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${style.iconBg} text-white shadow-sm sm:h-10 sm:w-10`}
        >
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className={`whitespace-nowrap font-medium leading-5 text-slate-500 ${featured ? 'text-sm' : 'text-[13px]'}`}>
            {t(card.label || style.label)}
          </p>
          <span
            className={`chip mt-1 hidden max-w-full text-[10px] sm:inline-flex ${
              up == null
                ? 'bg-slate-100 text-slate-400'
                : up
                  ? 'bg-emerald-50 text-emerald-600'
                  : 'bg-rose-50 text-rose-500'
            }`}
          >
            {hide ? '—' : up == null ? t('较上月 —') : t('较上月 {pct}', { pct: pctText(card.change) })}
          </span>
        </div>
      </div>

      <div className="mt-3 min-w-0 sm:mt-4">
        {hide ? (
          <>
            <p className="text-[26px] font-semibold leading-none tracking-tight text-slate-300">•••</p>
            {isStore && (
              <p className="mt-2 hidden text-[11px] text-slate-400 sm:block">
                {t('经营数据仅开发者可见')}
              </p>
            )}
          </>
        ) : (
          <p
            className={`whitespace-nowrap font-semibold leading-none tracking-tight tabular-nums text-slate-800 ${
              featured ? 'text-[22px] sm:text-[30px] 2xl:text-[22px]' : 'text-[17px] sm:text-[26px] 2xl:text-[22px]'
            }`}
          >
            {card.prefix}
            {card.value}
            <span className="ml-1 text-xs font-medium text-slate-400">{card.unit}</span>
          </p>
        )}
        <div className="mt-2 flex min-h-11 items-end justify-between gap-2">
          {!hide && <p className="hidden min-w-0 text-[11px] leading-4 text-slate-400 sm:line-clamp-2">{card.note}</p>}
          <div className="h-9 w-12 shrink-0 sm:h-11 sm:w-20">
            <Sparkline values={spark} color={style.color} id={`spark-${card.key}`} />
          </div>
        </div>
      </div>
    </div>
  )
}

/** 迷你趋势图（纯 SVG，无第三方图表库，首屏零额外依赖） */
function Sparkline({ values, color, id }) {
  if (!values || values.length < 2) return <div className="h-full w-full" />
  const w = 100
  const h = 40
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w
    const y = h - 3 - ((v - min) / span) * (h - 6)
    return [x, y]
  })
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
  const area = `${line} L${w},${h} L0,${h} Z`
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-full w-full">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.3} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}
