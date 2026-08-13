import { useEffect, useState } from 'react'
import { BadgeDollarSign, Loader2, RotateCcw, X } from 'lucide-react'
import { api } from '../utils/api'
import { employeeDailyPayDetail } from '../utils/selectors'
import {
  removeDailyPayAdjustment,
  upsertDailyPayAdjustment,
} from '../utils/userData'
import { useI18n } from '../i18n'

function localDate() {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function normalizeApiRow(row) {
  return {
    id: row.id,
    staffName: row.staffName,
    date: String(row.date || '').slice(0, 10),
    autoPayCentsSnapshot: Number(row.autoPayCentsSnapshot) || 0,
    adjustedPayCents: Number(row.adjustedPayCents) || 0,
    reason: row.reason || '',
    createdBy: row.createdBy || '',
    updatedBy: row.updatedBy || '',
    createdAt: row.createdAt || '',
    updatedAt: row.updatedAt || '',
    version: Number(row.version) || 1,
  }
}

function yuan(value) {
  return Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function signedYuan(value) {
  const amount = Number(value) || 0
  return `${amount >= 0 ? '+' : '-'}¥${yuan(Math.abs(amount))}`
}

export default function DailyPayAdjustmentModal({ emp, initialDate, onClose, onSaved }) {
  const { t } = useI18n()
  const [date, setDate] = useState(initialDate || localDate())
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [tip, setTip] = useState('')
  const detail = /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? employeeDailyPayDetail(date.slice(0, 7), date.slice(5), emp.name)
    : null
  const current = detail?.totals?.payAdjustment || null
  const automaticPay = detail?.totals?.automaticPay ?? 0

  useEffect(() => {
    if (current) {
      setAmount((Number(current.adjustedPayCents) / 100).toFixed(2))
      setReason(current.reason || '')
    } else {
      setAmount(detail ? Number(automaticPay).toFixed(2) : '')
      setReason('')
    }
    setError('')
  }, [current?.id, current?.version, date, automaticPay])

  useEffect(() => {
    const onKey = (event) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const adjusted = Number(amount)
  const difference = Number.isFinite(adjusted) ? adjusted - automaticPay : 0

  const save = async () => {
    setError('')
    setTip('')
    if (!detail) {
      setError(t('该员工当天没有值班记录，不能调整工资'))
      return
    }
    const adjustedPayCents = Math.round(adjusted * 100)
    if (String(amount).trim() === '' || !Number.isFinite(adjusted) || adjustedPayCents < 0) {
      setError(t('请输入正确的调整后工资'))
      return
    }
    if (!reason.trim()) {
      setError(t('请填写调整原因'))
      return
    }
    setBusy(true)
    try {
      const result = await api('/v2/daily-pay-adjustments', {
        method: 'PUT',
        body: JSON.stringify({
          staffName: emp.name,
          date,
          autoPayCentsSnapshot: Math.round(automaticPay * 100),
          adjustedPayCents,
          reason: reason.trim(),
          version: current?.version,
        }),
      })
      upsertDailyPayAdjustment(normalizeApiRow(result.adjustment))
      setTip(t('当日工资已调整并生效'))
      onSaved?.()
    } catch (err) {
      if (err.status === 409 && err.data?.latest) {
        upsertDailyPayAdjustment(normalizeApiRow(err.data.latest))
        onSaved?.()
      }
      setError(t(err.message))
    } finally {
      setBusy(false)
    }
  }

  const restore = async () => {
    if (!current || !window.confirm(t('确定恢复为系统自动计算的当日工资吗？'))) return
    setBusy(true)
    setError('')
    try {
      await api(`/v2/daily-pay-adjustments/${current.id}`, {
        method: 'DELETE',
        body: JSON.stringify({ version: current.version }),
      })
      removeDailyPayAdjustment(current.id)
      setTip(t('已恢复系统自动计算'))
      onSaved?.()
    } catch (err) {
      setError(t(err.message))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={t('调整每日薪资')}>
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-6 shadow-lg">
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-violet-50 text-violet-600">
            <BadgeDollarSign className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-slate-800">{t('调整每日薪资')}</h3>
            <p className="mt-0.5 text-xs text-slate-400">{emp.name} · {t('调整后金额将作为当天最终工资')}</p>
          </div>
          <button onClick={onClose} className="ml-auto grid h-9 w-9 place-items-center rounded-xl bg-slate-50 text-slate-400" aria-label={t('关闭')}>
            <X className="h-5 w-5" />
          </button>
        </div>

        {tip && <p className="mt-4 rounded-xl bg-emerald-50 px-4 py-2.5 text-xs font-semibold text-emerald-600">{tip}</p>}
        {error && <p className="mt-4 rounded-xl bg-rose-50 px-4 py-2.5 text-xs font-medium text-rose-500">{error}</p>}

        <div className="mt-5 space-y-4">
          <div>
            <label className="mb-1.5 block text-xs font-semibold text-slate-500">{t('工资日期')}</label>
            <input type="date" value={date} onChange={(event) => { setDate(event.target.value); setTip('') }} className="input w-full" />
          </div>

          {!detail ? (
            <div className="rounded-xl border border-amber-100 bg-amber-50 px-4 py-3 text-xs font-medium text-amber-600">
              {t('该员工当天没有值班记录，不能调整工资')}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-xl bg-slate-50 px-3 py-2.5">
                  <p className="text-[10px] text-slate-400">{t('自动工资')}</p>
                  <p className="mt-1 font-bold tabular-nums text-slate-700">¥{yuan(automaticPay)}</p>
                </div>
                <div className="rounded-xl bg-violet-50 px-3 py-2.5">
                  <p className="text-[10px] text-violet-500">{t('调整差额')}</p>
                  <p className="mt-1 font-bold tabular-nums text-violet-600">{signedYuan(difference)}</p>
                </div>
                <div className="rounded-xl bg-budu-50 px-3 py-2.5">
                  <p className="text-[10px] text-budu-500">{t('最终工资')}</p>
                  <p className="mt-1 font-bold tabular-nums text-budu-600">¥{yuan(adjusted)}</p>
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-semibold text-slate-500">{t('调整后工资（元）')}</label>
                <input type="number" min="0" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} className="input w-full" inputMode="decimal" />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-semibold text-slate-500">{t('调整原因')}</label>
                <textarea value={reason} onChange={(event) => setReason(event.target.value.slice(0, 200))} rows={3} className="input w-full resize-none" placeholder={t('例如：临时加班、请假扣减、特殊奖励')} />
                <p className="mt-1 text-right text-[10px] text-slate-300">{reason.length}/200</p>
              </div>
            </>
          )}

          {current && (
            <div className="rounded-xl border border-violet-100 bg-violet-50/60 px-4 py-3 text-xs text-violet-700">
              <p className="font-bold">{t('当前人工调整明细')}</p>
              <p className="mt-1.5">{t('自动 ¥{auto} → 最终 ¥{final}（差额 {difference}）', {
                auto: yuan(current.autoPaySnapshot),
                final: yuan(current.adjustedPay),
                difference: signedYuan(current.recordedDifference),
              })}</p>
              <p className="mt-1 break-words">{t('原因')}：{current.reason}</p>
              <p className="mt-1 text-violet-400">{t('操作人')}：{current.updatedBy || current.createdBy || '—'} · {current.updatedAt ? new Date(current.updatedAt).toLocaleString('zh-CN') : '—'}</p>
            </div>
          )}
        </div>

        <div className="mt-5 flex gap-2.5">
          {current && (
            <button onClick={restore} disabled={busy} className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-500 disabled:opacity-50">
              <RotateCcw className="h-4 w-4" />
              {t('恢复自动计算')}
            </button>
          )}
          <button onClick={save} disabled={busy || !detail} className="ml-auto inline-flex min-w-32 items-center justify-center gap-1.5 rounded-xl bg-violet-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm disabled:opacity-50">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {t(current ? '更新调整' : '确认调整')}
          </button>
        </div>
      </div>
    </div>
  )
}
