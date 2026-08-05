import { MoreHorizontal } from 'lucide-react'
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'
import Card from './Card'
import { costStructure } from '../data/mockData'

function CostTooltip({ active, payload }) {
  if (!active || !payload || !payload.length) return null
  const item = payload[0]
  return (
    <div className="rounded-xl border border-white/60 bg-white/95 px-3.5 py-2.5 text-xs shadow-card backdrop-blur">
      <p className="flex items-center gap-1.5 font-semibold text-slate-700">
        <span className="h-2 w-2 rounded-full" style={{ background: item.payload.color }} />
        {item.name}
      </p>
      <p className="mt-1 text-slate-500">
        占比 <span className="font-bold text-slate-700">{item.value}%</span> · 约
        <span className="font-semibold text-slate-700">
          {' '}
          ¥{(78.4 * (item.value / 100)).toFixed(1)} 万
        </span>
      </p>
    </div>
  )
}

export default function CostStructureChart() {
  return (
    <Card
      title="成本结构分析"
      subtitle="本月各成本项占比"
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
              data={costStructure}
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
              {costStructure.map((item) => (
                <Cell key={item.name} fill={item.color} />
              ))}
            </Pie>
            <Tooltip content={<CostTooltip />} />
          </PieChart>
        </ResponsiveContainer>
        {/* 中心汇总 */}
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="text-center">
            <p className="text-[10px] tracking-wide text-slate-400">本月总成本</p>
            <p className="text-lg font-extrabold text-slate-800">¥78.4 万</p>
          </div>
        </div>
      </div>

      {/* 图例明细 */}
      <ul className="mt-5 space-y-2">
        {costStructure.map((item) => (
          <li key={item.name} className="flex items-center gap-2 text-xs">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: item.color }} />
            <span className="flex-1 text-slate-500">{item.name}</span>
            <span className="font-bold text-slate-700">{item.value}%</span>
          </li>
        ))}
      </ul>
    </Card>
  )
}
