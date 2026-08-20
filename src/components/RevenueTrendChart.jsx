import { ChevronDown } from 'lucide-react'
import {
  CartesianGrid,
  Line,
  ReferenceDot,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import Card from './Card'
import { dailyRows, periodDailyRows, periodStats, storeName, monthLabel } from '../utils/selectors'
import { formatMoney } from '../utils/format'
import { t } from '../utils/text'
import { usePublicMode, useStorePrivacy } from '../visibility'

function shortDate(d) {
  const [m, day] = d.split('-')
  return `${Number(m)}/${Number(day)}`
}

function TrendTooltip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null
  const revenue = payload.find((p) => p.dataKey === 'revenue')
  const orders = payload.find((p) => p.dataKey === 'orders')
  return (
    <div className="rounded-xl border border-slate-200/70 bg-white/95 px-3.5 py-2.5 text-xs shadow-card backdrop-blur">
      <p className="mb-1.5 font-bold text-slate-700">{shortDate(label)}</p>
      <p className="flex items-center gap-1.5 text-slate-500">
    <span className="h-2 w-2 rounded-full bg-budu-500" />
        {t('营业收入：')}<span className="font-semibold text-slate-700">¥{formatMoney(revenue?.value ?? 0)}</span>
      </p>
      <p className="mt-1 flex items-center gap-1.5 text-slate-500">
        <span className="h-2 w-2 rounded-full bg-budu-400" />
        {t('订单数：')}
        <span className="font-semibold text-slate-700">
          {t('{n} 单', { n: Number(orders?.value ?? 0).toLocaleString('zh-CN') })}
        </span>
      </p>
    </div>
  )
}

export default function RevenueTrendChart({ month, store, day, weekStart }) {
  const isPublic = usePublicMode()
  const isStore = useStorePrivacy()
  const hide = isPublic || isStore
  const rows = weekStart ? periodDailyRows(month, store, null, weekStart) : dailyRows(month, store)
  const agg = periodStats(month, store, day, weekStart)
  const data = rows.map((r) => ({ d: r.date ? r.date.slice(5) : r.d, revenue: r.inc, orders: r.ord }))
  const focus = day ? data.find((x) => x.d === day) : null
  const peak = Math.max(1, ...data.map((d) => d.revenue))
  const peakOrders = Math.max(1, ...data.map((d) => d.orders))

  return (
    <Card
      title={t('营业额趋势')}
      subtitle={
        weekStart
          ? t('{start} 起 · {store} 自然周趋势', { start: weekStart, store: storeName(store) })
          : day
          ? t('{month} · {store} 聚焦 {day}', {
              month: monthLabel(month),
              store: storeName(store),
              day,
            })
          : t('{month} · {store} 每日营业收入与订单数', {
              month: monthLabel(month),
              store: storeName(store),
            })
      }
      action={
        !hide && (
        <label className="flex cursor-pointer items-center gap-1 rounded-xl bg-slate-50 px-2.5 py-1.5 text-xs font-medium text-slate-500">
          {t('按日')}
          <ChevronDown className="h-3.5 w-3.5 text-slate-300" />
        </label>
        )
      }
    >
      {hide ? (
        <div className="grid h-64 place-items-center text-xs text-slate-300">
          {t(isPublic ? '对外展示模式 · 数据已隐藏' : '门店运营模式 · 经营数据已隐藏')}
        </div>
      ) : (
        <>
      <div className="mb-4 flex items-center gap-5 text-xs text-slate-500">
        <span className="flex items-center gap-1.5">
    <span className="h-2.5 w-2.5 rounded-full bg-slate-400" />
          {t('营业收入（元）')}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-budu-400" />
          {t('订单数（单）')}
        </span>
    <span className="ml-auto hidden rounded-lg bg-slate-100 px-2 py-1 font-semibold text-slate-600 sm:block">
          {weekStart
            ? t('周收入 ¥{inc} · {ord} 单', { inc: formatMoney(agg.inc), ord: agg.ord })
            : day
            ? t('当日 ¥{inc} · {ord} 单', {
                inc: formatMoney(focus ? focus.revenue : 0),
                ord: focus ? focus.orders : 0,
              })
            : t('月收入 ¥{inc} · {ord} 单', { inc: formatMoney(agg.inc), ord: agg.ord })}
        </span>
      </div>

      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 6, right: 4, left: 4, bottom: 0 }} isAnimationActive={false}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#EEEEF0" />
            <XAxis
              dataKey="d"
              tickLine={false}
              axisLine={false}
              tick={{ fill: '#94A3B8', fontSize: 11 }}
              tickFormatter={shortDate}
              minTickGap={28}
              dy={8}
            />
            <YAxis
              yAxisId="revenue"
              domain={[0, Math.ceil((peak * 1.15) / 1000) * 1000]}
              tickLine={false}
              axisLine={false}
              width={46}
              tick={{ fill: '#94A3B8', fontSize: 11 }}
              tickFormatter={(v) => (v >= 1000 ? `${v / 1000}k` : `${v}`)}
            />
            <YAxis
              yAxisId="orders"
              orientation="right"
              domain={[0, Math.ceil((peakOrders * 1.15) / 10) * 10]}
              tickLine={false}
              axisLine={false}
              width={40}
              tick={{ fill: '#94A3B8', fontSize: 11 }}
            />
            <Tooltip content={<TrendTooltip />} cursor={{ stroke: '#E2E8F0', strokeDasharray: '4 4' }} />
            {focus && (
              <ReferenceDot yAxisId="revenue" x={focus.d} y={focus.revenue} r={5} fill="#BC4F7E" stroke="#fff" strokeWidth={2} />
            )}
            <Line
              yAxisId="revenue"
              type="monotone"
              dataKey="revenue"
              name={t('营业收入')}
              stroke="#BC4F7E"
              strokeWidth={2.5}
              dot={false}
              activeDot={{ r: 5, strokeWidth: 0 }}
            />
            <Line
              yAxisId="orders"
              type="monotone"
              dataKey="orders"
              name={t('订单数')}
              stroke="#94A3B8"
              strokeWidth={2}
              strokeDasharray="6 4"
              dot={false}
              activeDot={{ r: 4, strokeWidth: 0 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
        </>
      )}
    </Card>
  )
}
