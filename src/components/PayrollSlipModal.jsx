// 工资条弹窗：员工查看每日明细 + 汇总 + 确认签收；开发者/管理员/财务可撤回（未签收）或删除
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, RotateCcw, Trash2, X } from 'lucide-react'
import { api } from '../utils/api'
import { t } from '../utils/text'
import { periodLabel } from '../utils/payrollSlip'
import PayrollSlipCard from './PayrollSlipCard'

export default function PayrollSlipModal({ notice, onClose, onConfirmed, onOpenProfile, canManage = false }) {
  const [confirming, setConfirming] = useState(false)
  const [acting, setActing] = useState('') // '' | 'recall' | 'delete'
  const [error, setError] = useState('')
  const confirmed = notice.status === 'confirmed'
  const recalled = notice.status === 'recalled'

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

  const recallSlip = async () => {
    if (!window.confirm(t('确定撤回该工资条？撤回后员工无法签收，且可重新发放修正。'))) return
    setActing('recall')
    setError('')
    try {
      await api(`/v2/payroll-notices/${notice.id}/recall`, { method: 'POST' })
      onConfirmed?.(notice.id)
    } catch (e) {
      setError(e.message)
    } finally {
      setActing('')
    }
  }

  const deleteSlip = async () => {
    const tip = confirmed
      ? t('该工资条已被员工签收，删除后签收记录将不再展示。确定删除？')
      : t('确定删除该工资条？删除后同周期可重新发放。')
    if (!window.confirm(tip)) return
    setActing('delete')
    setError('')
    try {
      await api(`/v2/payroll-notices/${notice.id}/delete`, { method: 'POST' })
      onConfirmed?.(notice.id)
    } catch (e) {
      setError(e.message)
    } finally {
      setActing('')
    }
  }

  const busy = confirming || Boolean(acting)

  return createPortal(
    <div className="fixed inset-0 z-[96] flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative max-h-[88vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-lg">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-slate-400">
              {notice.periodType === 'week' ? '周度' : notice.periodType === 'custom' ? '自定义日期' : '月度'} · {periodLabel(notice.periodType, notice.periodKey, notice.periodStart, notice.periodEnd)}
            </p>
            {notice.status !== 'pending' && (
              <p
                className={`mt-1 w-fit rounded-md px-2 py-0.5 text-[10px] font-bold ${
                  recalled
                    ? 'bg-rose-50 text-rose-600'
                    : confirmed
                      ? 'bg-emerald-50 text-emerald-600'
                      : 'bg-slate-100 text-slate-500'
                }`}
              >
                {recalled ? t('已撤回') : confirmed ? t('已签收') : t('已删除')}
              </p>
            )}
          </div>
          <button onClick={onClose} className="ml-auto grid h-9 w-9 place-items-center rounded-xl bg-slate-50 text-slate-400 transition hover:bg-slate-100">
            <X className="h-5 w-5" />
          </button>
        </div>

        {error && <p className="mt-3 rounded-xl bg-rose-50 px-4 py-2.5 text-sm text-rose-600">{error}</p>}

        <div className="mt-1">
          <PayrollSlipCard
            employeeName={notice.employeeName}
            periodText={periodLabel(notice.periodType, notice.periodKey, notice.periodStart, notice.periodEnd)}
            snapshot={notice.snapshot}
            onOpenProfile={onOpenProfile}
          />
        </div>

        {/* 签收区 */}
        <div className="mt-4 border-t border-slate-100 pt-4">
          {recalled ? (
            <div className="flex items-center justify-between rounded-xl bg-rose-50 px-4 py-3">
              <p className="text-sm font-semibold text-rose-600">{t('该工资条已被撤回，无需签收')}</p>
              {notice.recalledBy && (
                <p className="text-xs text-rose-500">
                  {notice.recalledBy} · {notice.recalledAt ? new Date(notice.recalledAt).toLocaleString('zh-CN', { hour12: false }) : ''}
                </p>
              )}
            </div>
          ) : confirmed ? (
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
                disabled={busy}
                className="w-full max-w-sm rounded-xl bg-budu-500 py-3 text-sm font-bold text-white shadow-sm transition hover:opacity-90 disabled:opacity-50"
              >
                {confirming ? '提交中…' : '确认本人签收核对'}
              </button>
            </div>
          )}
        </div>

        {/* 管理操作区（开发者/管理员/财务） */}
        {canManage && notice.status !== 'deleted' && (
          <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 pt-3">
            {!confirmed && !recalled && (
              <button
                onClick={recallSlip}
                disabled={busy}
                className="flex items-center gap-1.5 rounded-xl bg-amber-50 px-3.5 py-2 text-xs font-semibold text-amber-700 transition hover:bg-amber-100 disabled:opacity-50"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {acting === 'recall' ? t('撤回中…') : t('撤回工资条')}
              </button>
            )}
            {confirmed && !recalled && (
              <p className="mr-auto text-[11px] text-slate-400">{t('员工已签收，如需修正请删除后重新发放')}</p>
            )}
            <button
              onClick={deleteSlip}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-xl bg-rose-50 px-3.5 py-2 text-xs font-semibold text-rose-600 transition hover:bg-rose-100 disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {acting === 'delete' ? t('删除中…') : t('删除工资条')}
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
