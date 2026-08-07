import {
  TrendingUp,
  ShoppingBag,
  Wallet,
  UtensilsCrossed,
  BadgePercent,
  CalendarCheck2,
} from 'lucide-react'
import { Area, AreaChart, ResponsiveContainer } from 'recharts'
import { pctText } from '../utils/selectors'
import { useI18n } from '../i18n'
import { usePublicMode, useStorePrivacy } from '../visibility'

const CARD_STYLE = {
  income: { label: '营业收入', gradient: 'from-budu-400 to-grape-500', color: '#A855F7', icon: TrendingUp },
  orders: { label: '订单数', gradient: 'from-rose-400 to-budu-500', color: '#EC4899', icon: ShoppingBag },
  avgOrder: { label: '客单价', gradient: 'from-amber-400 to-orange-500', color: '#F59E0B', icon: Wallet },
  dish: { label: '菜品销量', gradient: 'from-emerald-400 to-teal-500', color: '#10B981', icon: UtensilsCrossed },
  discount: { label: '优惠金额', gradient: 'from-sky-400 to-indigo-500', color: '#6366F1', icon: BadgePercent },
  dailyAvg: { label: '日均营业额', gradient: 'from-violet-400 to-purple-600', color: '#8B5CF6', icon: CalendarCheck2 },
}

export default function KpiCard({ card }) {
  const { t } = useI18n()
  const isPublic = usePublicMode()
  const isStore = useStorePrivacy()
  const hide = isPublic || isStore
  const style = CARD_STYLE[card.key] || CARD_STYLE.income
  const Icon = style.icon
  const sparkData = card.spark.map((v, i) => ({ i, v }))
  const up = card.change == null ? null : card.change >= 0

  return (
    <div className="card group min-w-0 p-3.5 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-card-hover sm:p-5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <div
            className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br ${style.gradient} text-white shadow-md sm:h-10 sm:w-10`}
          >
            <Icon className="h-5 w-5" />
          </div>
          <p className="truncate text-[13px] font-medium text-slate-500">{t(card.label || style.label)}</p>
        </div>
        <span
          className={`chip hidden shrink-0 sm:inline-flex ${
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

      <div className="mt-3 flex items-end justify-between gap-1.5 sm:mt-4 sm:gap-2">
        <div className="min-w-0">
          {hide ? (
            <>
              <p className="text-[26px] font-extrabold leading-none tracking-tight text-slate-300">•••</p>
              {isStore && (
                <p className="mt-2 hidden text-[11px] text-slate-400 sm:block">
                  {t('经营数据仅开发者可见')}
                </p>
              )}
            </>
          ) : (
            <>
              <p className="truncate text-[17px] font-extrabold leading-none tracking-tight text-slate-800 sm:text-[26px]">
                {card.prefix}
                {card.value}
                <span className="ml-1 text-xs font-medium text-slate-400">{card.unit}</span>
              </p>
              <p className="mt-2 hidden text-[11px] text-slate-400 sm:block">{card.note}</p>
            </>
          )}
        </div>
        <div className="h-9 w-12 shrink-0 sm:h-11 sm:w-24">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={sparkData} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id={`spark-${card.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={style.color} stopOpacity={0.3} />
                  <stop offset="100%" stopColor={style.color} stopOpacity={0} />
                </linearGradient>
              </defs>
              <Area
                type="monotone"
                dataKey="v"
                stroke={style.color}
                strokeWidth={2}
                fill={`url(#spark-${card.key})`}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  )
}
