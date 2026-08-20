// 工资条弹窗：员工查看每日明细 + 汇总 + 确认签收
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, X } from 'lucide-react'
import { api } from '../utils/api'
import { t } from '../utils/text'
import { periodLabel } from '../utils/payrollSlip'
import PayrollSlipCard from './PayrollSlipCard'

export default function PayrollSlipModal({ notice, onClose, onConfirmed }) {
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState('')
  const confirmed = notice.status === 'confirmed'

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
          <div className="min-w-0 flex-1">
            <p className="text-xs text-slate-400">
              {notice.periodType === 'week' ? '兼职周结' : notice.periodType === 'custom' ? '自定周期' : '全职月结'} · {periodLabel(notice.periodType, notice.periodKey)}
            </p>
          </div>
          <button onClick={onClose} className="ml-auto grid h-9 w-9 place-items-center rounded-xl bg-slate-50 text-slate-400 transition hover:bg-slate-100">
            <X className="h-5 w-5" />
          </button>
        </div>

        {error && <p className="mt-3 rounded-xl bg-rose-50 px-4 py-2.5 text-sm text-rose-600">{error}</p>}

        <div className="mt-1">
          <PayrollSlipCard
            employeeName={notice.employeeName}
            periodText={periodLabel(notice.periodType, notice.periodKey)}
            snapshot={notice.snapshot}
          />
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
