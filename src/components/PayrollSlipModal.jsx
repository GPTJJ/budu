// 工资条弹窗：员工查看每日明细 + 汇总 + 确认签收
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { BadgeDollarSign, CheckCircle2, X } from 'lucide-react'
import { api } from '../utils/api'
import { useI18n } from '../i18n'
import { periodLabel } from '../utils/payrollSlip'

function fmt(v) {
  return `¥${Number(v || 0).toFixed(2)}`
}

export default function PayrollSlipModal({ notice, onClose, onConfirmed }) {
  const { t } = useI18n()
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState('')
  const snapshot = notice.snapshot || { days: [], summary: {} }
  const confirmed = notice.status === 'confirmed'
  const isWeek = notice.periodType === 'week'

  const confirmSlip = async () => {
    setConfirming(true)
    setError('')
    try {
      await api(`/v2/payroll-notices/${notice.id}/confirm`, { method: 'POST' })
      onConfirmed?.(notice.id)
    } catch (e) {
      setError(e.message)
    } finally {
      setConfirming(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[96] flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative max-h-[88vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-lg">
        <div className="flex flex-wrap items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-2xl bg-budu-50 text-budu-600">
            <BadgeDollarSign className="h-6 w-6" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-slate-800">
              工资条 · {notice.employeeName}
            </h3>
            <p className="mt-0.5 text-xs text-slate-400">
              {isWeek ? '兼职周结' : '全职月结'} · {periodLabel(notice.periodType, notice.periodKey)} · 每日工资明细及汇总
            </p>
          </div>
          <button onClick={onClose} className="ml-auto grid h-9 w-9 place-items-center rounded-xl bg-slate-50 text-slate-400 transition hover:bg-slate-100">
            <X className="h-5 w-5" />
          </button>
        </div>

        {error && <p className="mt-3 rounded-xl bg-rose-50 px-4 py-2.5 text-sm text-rose-600">{error}</p>}

        {/* 汇总卡 */}
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            ['出勤天数', `${snapshot.summary.workedDays || 0} 天`],
            ['总工时', `${snapshot.summary.hours || 0}h`],
            ['基础工资', fmt(snapshot.summary.basePay)],
            ['业绩提成', fmt(snapshot.summary.commission)],
            ['调货补贴', fmt(snapshot.summary.transferSubsidy)],
            ['大单奖', fmt(snapshot.summary.bigBonus)],
            ['薪资调整', fmt(snapshot.summary.adjustment)],
          ].map(([label, value]) => (
            <div key={label} className="rounded-xl bg-slate-50 px-3 py-2.5">
              <p className="text-[11px] text-slate-400">{label}</p>
              <p className="mt-0.5 text-sm font-bold tabular-nums text-slate-700">{value}</p>
            </div>
          ))}
          <div className="rounded-xl bg-budu-50 px-3 py-2.5">
            <p className="text-[11px] text-budu-400">实发合计</p>
            <p className="mt-0.5 text-lg font-black tabular-nums text-budu-600">{fmt(snapshot.summary.total)}</p>
          </div>
        </div>

        {/* 每日明细 */}
        <div className="mt-3 flex items-center gap-4 text-[11px] text-slate-400">
          <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-full bg-amber-400" />周末 / 法定节假日</span>
          <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-400" />调休上班</span>
        </div>
        <div className="mt-2 max-h-[36vh] overflow-x-auto overflow-y-auto rounded-xl border border-slate-100">
          <table className="w-full min-w-[720px] text-left text-xs">
            <thead className="sticky top-0 bg-slate-50 text-slate-400">
              <tr>
                <th className="px-3 py-2">日期</th>
                <th className="px-3 py-2 text-right">工时</th>
                <th className="px-3 py-2 text-right">基础工资</th>
                <th className="px-3 py-2 text-right">提成</th>
                <th className="px-3 py-2 text-right">调货补贴</th>
                <th className="px-3 py-2 text-right">大单奖</th>
                <th className="px-3 py-2 text-right">调整</th>
                <th className="px-3 py-2 text-right">当日工资</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {snapshot.days.map((r) => (
                <tr key={r.day} className={r.hasData ? '' : 'text-slate-300'}>
                  <td className="px-3 py-1.5 font-semibold">
                    <span className={r.mark === 'holiday' || r.mark === 'weekend' ? 'text-amber-600' : r.mark === 'makeup' ? 'text-emerald-600' : 'text-slate-700'}>
                      {r.day}
                      {r.mark === 'holiday' && <span className="ml-1 rounded bg-amber-100 px-1 py-0.5 text-[9px] font-bold text-amber-700">假</span>}
                      {r.mark === 'makeup' && <span className="ml-1 rounded bg-emerald-50 px-1 py-0.5 text-[9px] font-bold text-emerald-600">班</span>}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{r.hasData ? `${r.hours}h` : '—'}</td>
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

        {/* 签收区 */}
        <div className="mt-4 border-t border-slate-100 pt-4">
          {confirmed ? (
            <div className="flex items-center justify-between rounded-xl bg-emerald-50 px-4 py-3">
              <p className="text-sm font-semibold text-emerald-700">
                <CheckCircle2 className="mr-1.5 inline h-4 w-4" />
                已确认签收
              </p>
              <p className="text-xs text-emerald-600">
                {notice.confirmedBy} · {notice.confirmedAt ? new Date(notice.confirmedAt).toLocaleString('zh-CN', { hour12: false }) : ''}
              </p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3">
              <p className="text-xs text-slate-400">请核对以上每日工资明细及汇总，确认无误后签收；签收后如有疑问请联系开发者。</p>
              <button
                onClick={confirmSlip}
                disabled={confirming}
                className="w-full max-w-sm rounded-xl bg-budu-500 py-3 text-sm font-bold text-white shadow-sm transition hover:opacity-90 disabled:opacity-50"
              >
                {confirming ? '提交中…' : '确认本人签收核对'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
