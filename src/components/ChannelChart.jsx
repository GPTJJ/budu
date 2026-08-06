import { MoreHorizontal } from 'lucide-react'
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'
import Card from './Card'
import { channelData, aggregate, storeName, monthLabel } from '../utils/selectors'
import { formatMoney } from '../utils/format'
import { useI18n } from '../i18n'

function ChannelTooltip({ active, payload }) {
  const { t } = useI18n()
  if (!active || !payload || !payload.length) return null
  const item = payload[0]
  return (
    <div className="rounded-xl border border-white/60 bg-white/95 px-3.5 py-2.5 text-xs shadow-card backdrop-blur">
      <p className="flex items-center gap-1.5 font-semibold text-slate-700">
        <span className="h-2 w-2 rounded-full" style={{ background: item.payload.color }} />
        {item.name}
      </p>
      <p className="mt-1 text-slate-500">
        {t('营业收入')} <span className="font-bold text-slate-700">¥{formatMoney(item.value)}</span>
        <span className="ml-2">
          {t('占比')} <span className="font-bold text-slate-700">{item.payload.pct}%</span>
        </span>
      </p>
    </div>
  )
}

export default function ChannelChart({ month, store, day }) {
  const { lang, t } = useI18n()
  const data = channelData(month, store, day)
  const agg = aggregate(month, store)
  const total = data.reduce((s, x) => s + x.value, 0) || 1
  const withPct = data.map((x) => ({ ...x, pct: ((x.value / total) * 100).toFixed(1) }))

  return (
    <Card
      title={t('渠道销售构成')}
      subtitle={
        day
          ? t('{month} · {store} {day} 按日', {
              month: monthLabel(month, lang),
              store: storeName(store),
              day,
            })
          : `${monthLabel(month, lang)} · ${storeName(store)}`
      }
      action={
        <button className="grid h-8 w-8 place-items-center rounded-xl text-slate-300 transition hover:bg-slate-50 hover:text-slate-500">
          <MoreHorizontal className="h-4 w-4" />
        </button>
      }
    >
      <div className="relative mx-auto mt-1 h-52 w-52">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={withPct}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
              innerRadius={62}
              outerRadius={88}
              paddingAngle={3}
              cornerRadius={6}
              strokeWidth={0}
            >
              {withPct.map((item) => (
                <Cell key={item.name} fill={item.color} />
              ))}
            </Pie>
            <Tooltip content={<ChannelTooltip />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="text-center">
            <p className="text-[10px] tracking-wide text-slate-400">{t('营业收入')}</p>
            <p className="text-base font-extrabold text-slate-800">
              ¥{formatMoney(agg.inc)}
            </p>
          </div>
        </div>
      </div>

      <ul className="mt-5 space-y-2">
        {withPct.map((item) => (
          <li key={item.name} className="flex items-center gap-2 text-xs">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: item.color }} />
            <span className="flex-1 text-slate-500">{t(item.name)}</span>
            <span className="font-semibold tabular-nums text-slate-500">
              ¥{formatMoney(item.value)}
            </span>
            <span className="w-11 text-right font-bold text-slate-700">{item.pct}%</span>
          </li>
        ))}
      </ul>
    </Card>
  )
}
