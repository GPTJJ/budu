// 工资条卡片（纯展示）：员工明细 + 汇总
// 用于工资条弹窗（PayrollSlipModal）与工资审批图片附件（html-to-image 截图）
// 注意：full=true（截图）时绝不渲染交互元素（onOpenProfile 仅弹窗场景传入）
import { BadgeDollarSign, IdCard } from 'lucide-react'

function fmt(v) {
  return `¥${Number(v || 0).toFixed(2)}`
}

export default function PayrollSlipCard({ employeeName, periodText, snapshot, full = false, onOpenProfile }) {
  const snap = snapshot || { days: [], summary: {} }
  return (
    <div className="rounded-2xl bg-white">
      {/* 头部 */}
      <div className="flex items-center gap-3 border-b border-slate-100 pb-4">
        <div className="grid h-11 w-11 place-items-center rounded-2xl bg-budu-50 text-budu-600">
          <BadgeDollarSign className="h-6 w-6" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-lg font-bold text-slate-800">工资条 · {employeeName}</h3>
          <p className="mt-0.5 text-xs text-slate-400">{periodText} · 每日工资明细及汇总</p>
        </div>
        {!full && onOpenProfile && (
          <button
            onClick={() => onOpenProfile(employeeName)}
            className="flex shrink-0 items-center gap-1.5 rounded-xl bg-budu-50 px-3 py-2 text-xs font-bold text-budu-600 transition hover:bg-budu-100"
            title="查看员工档案"
          >
            <IdCard className="h-4 w-4" />
            员工档案
          </button>
        )}
      </div>

      {/* 汇总卡 */}
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ['出勤天数', `${snap.summary.workedDays || 0} 天`],
          ['计薪工时', `${snap.summary.payableHours ?? snap.summary.hours ?? 0}h`],
          ['基础工资', fmt(snap.summary.basePay)],
          ['业绩提成', fmt(snap.summary.commission)],
          ['调货补贴', fmt(snap.summary.transferSubsidy)],
          ['大单奖', fmt(snap.summary.bigBonus)],
          ['薪资调整', fmt(snap.summary.adjustment)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl bg-slate-50 px-3 py-2.5">
            <p className="text-[11px] text-slate-400">{label}</p>
            <p className="mt-0.5 text-sm font-bold tabular-nums text-slate-700">{value}</p>
          </div>
        ))}
        <div className="rounded-xl bg-budu-50 px-3 py-2.5">
          <p className="text-[11px] text-budu-400">实发合计</p>
          <p className="mt-0.5 text-lg font-black tabular-nums text-budu-600">{fmt(snap.summary.total)}</p>
        </div>
      </div>

      {/* 每日明细 */}
      <div className="mt-3 flex items-center gap-4 text-[11px] text-slate-400">
        <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-full bg-amber-400" />周末 / 法定节假日</span>
        <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-400" />调休上班</span>
      </div>
      <div className={`mt-2 overflow-x-auto rounded-xl border border-slate-100 ${full ? '' : 'max-h-[36vh] overflow-y-auto'}`}>
        <table className="w-full min-w-[720px] text-left text-xs">
          <thead className="sticky top-0 bg-slate-50 text-slate-400">
            <tr>
              <th className="px-3 py-2">日期</th>
              <th className="px-3 py-2 text-right">计薪工时</th>
              <th className="px-3 py-2 text-right">基础工资</th>
              <th className="px-3 py-2 text-right">提成</th>
              <th className="px-3 py-2 text-right">调货补贴</th>
              <th className="px-3 py-2 text-right">大单奖</th>
              <th className="px-3 py-2 text-right">调整</th>
              <th className="px-3 py-2 text-right">当日工资</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {(snap.days || []).map((r, index) => (
              <tr key={`${r.date || r.day}|${r.storeKey || ''}|${index}`} className={r.hasData ? '' : 'text-slate-300'}>
                <td className="px-3 py-1.5 font-semibold">
                  <span className={r.mark === 'holiday' || r.mark === 'weekend' ? 'text-amber-600' : r.mark === 'makeup' ? 'text-emerald-600' : 'text-slate-700'}>
                    {r.day}
                    {r.mark === 'holiday' && <span className="ml-1 rounded bg-amber-100 px-1 py-0.5 text-[9px] font-bold text-amber-700">假</span>}
                    {r.mark === 'makeup' && <span className="ml-1 rounded bg-emerald-50 px-1 py-0.5 text-[9px] font-bold text-emerald-600">班</span>}
                  </span>
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.hasData ? `${r.payableHours ?? r.hours ?? 0}h` : '—'}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.hasData ? fmt(r.basePay) : '—'}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.hasData ? fmt(r.commission) : '—'}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.hasData && r.transferSubsidy ? fmt(r.transferSubsidy) : '—'}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.hasData && r.bigBonus ? fmt(r.bigBonus) : '—'}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.hasData && r.adjustment ? fmt(r.adjustment) : '—'}</td>
                <td className="px-3 py-1.5 text-right font-bold tabular-nums text-budu-600">{r.hasData ? fmt(r.pay) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
