import { useEffect, useMemo, useRef, useState } from 'react'
import { Award, Camera, ImageUp, Loader2, Plus, Trash2, X } from 'lucide-react'
import { api } from '../utils/api'
import { normalizeImage } from '../utils/image'
import { storeName } from '../utils/selectors'
import { t } from '../utils/text'

const inputCls = 'input'
const yuan = (cents) => (Number(cents || 0) / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function BigBonusModal({ emp, currentUser, onClose }) {
  const month = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [receipt, setReceipt] = useState('')
  const [preview, setPreview] = useState('')
  const [rows, setRows] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [tip, setTip] = useState('')
  const fileRef = useRef(null)
  const cameraRef = useRef(null)

  const staffKey = `${emp.storeKey}::${emp.name}`

  const load = async () => {
    setError('')
    try {
      const qs = new URLSearchParams({ staffKey, month })
      const d = await api(`/v2/big-bonuses?${qs}`)
      setRows(d.rows || [])
    } catch (err) {
      setError(t(err.message))
    }
  }

  useEffect(() => {
    load()
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const bonusCents = useMemo(() => {
    const cents = Math.round((Number(amount) || 0) * 100)
    return cents > 0 ? Math.round(cents * 0.05) : 0
  }, [amount])

  const totalCents = rows.reduce((s, r) => s + Number(r.bonusCents || 0), 0)

  const handleFile = async (e) => {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setError(t('请上传小票图片'))
      return
    }
    if (file.size > 25 * 1024 * 1024) {
      setError(t('图片不能超过 25MB'))
      return
    }
    const reader = new FileReader()
    reader.onload = async () => {
      const original = String(reader.result || '')
      setPreview(original)
      setError('')
      try {
        const dataUrl = await normalizeImage(original, file.type, 1600, 0.8)
        setReceipt(dataUrl)
      } catch (err) {
        setError(t(err.message))
      }
    }
    reader.readAsDataURL(file)
  }

  const save = async () => {
    setError('')
    const cents = Math.round((Number(amount) || 0) * 100)
    if (!(cents > 0)) {
      setError(t('请填写订单金额'))
      return
    }
    setBusy(true)
    try {
      await api('/v2/big-bonuses', {
        method: 'POST',
        body: JSON.stringify({
          // Gate 10：直接提交所选 Employee 对象的稳定 id（绝不按姓名/门店推导）；
          // staffName/storeKey 保留为历史快照。
          employeeId: emp.id || undefined,
          staffName: emp.name,
          storeKey: emp.storeKey,
          date,
          amountCents: cents,
          receipt,
        }),
      })
      setAmount('')
      setDate(new Date().toISOString().slice(0, 10))
      setReceipt('')
      setPreview('')
      setTip(t('大单奖已记录 ✓'))
      setTimeout(() => setTip(''), 2000)
      await load()
    } catch (err) {
      setError(t(err.message))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id) => {
    if (!window.confirm(t('确定删除该大单奖记录吗？'))) return
    try {
      await api(`/v2/big-bonuses/${id}`, { method: 'DELETE' })
      await load()
    } catch (err) {
      setError(t(err.message))
    }
  }

  return (
    <div data-budu-overlay-root className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="budu-overlay-backdrop absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-label={t('大单奖金')} className="budu-overlay-panel relative flex max-h-[88dvh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-lg">
        <div className="budu-overlay-header flex items-start justify-between gap-4 border-b border-slate-100 p-6 pb-4">
          <div>
            <h3 className="flex items-center gap-2 text-lg font-bold text-slate-800">
              <Award className="h-5 w-5 text-amber-500" />
              {t('大单奖')}
            </h3>
            <p className="mt-1 text-xs text-slate-400">
              {emp.name} · {storeName(emp.storeKey)} · {t('奖金 = 订单金额 × 5%（四舍五入）')}
            </p>
          </div>
          <button
            onClick={onClose}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-slate-50 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
            aria-label={t('关闭')}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-6 pt-4">
          {tip && <p className="rounded-xl bg-emerald-50 px-4 py-2 text-xs font-semibold text-emerald-600">{tip}</p>}
          {error && <p className="rounded-xl bg-rose-50 px-4 py-2 text-xs font-medium text-rose-500">{error}</p>}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-semibold text-slate-500">{t('大单日期')}</label>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-semibold text-slate-500">{t('订单金额（元）')}</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                className={inputCls}
              />
            </div>
            <div className="rounded-xl bg-amber-50/70 px-3 py-2">
              <p className="text-[10px] font-semibold text-amber-600">{t('自动计算奖金')}</p>
              <p className="mt-0.5 text-lg font-bold tabular-nums text-amber-600">¥{yuan(bonusCents)}</p>
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-semibold text-slate-500">{t('上传小票（选填）')}</label>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleFile} />
            <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={handleFile} />
            <button
              type="button"
              onClick={() => cameraRef.current?.click()}
              className="flex w-full items-center gap-3 rounded-2xl border-2 border-dashed border-amber-200 bg-amber-50/40 px-4 py-3 text-left transition hover:border-amber-400 hover:bg-amber-50"
            >
              {preview ? (
                <img src={preview} alt="小票" className="h-14 w-14 rounded-xl border border-slate-100 bg-white object-contain" />
              ) : (
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-white text-amber-500 shadow-sm">
                  <Camera className="h-5 w-5" />
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-slate-700">{t(preview ? '重新拍照上传' : '拍照上传小票')}</span>
                <span className="mt-0.5 block text-[11px] text-slate-400">{t('直接调起相机拍摄小票，自动压缩留档')}</span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="mt-1.5 flex items-center gap-1.5 text-xs font-medium text-slate-400 transition hover:text-amber-600"
            >
              <ImageUp className="h-3.5 w-3.5" />
              {t('从相册选择')}
            </button>
          </div>

          <button
            onClick={save}
            disabled={busy}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-semibold text-white transition active:scale-95 disabled:opacity-60"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            {t('记录大单奖')}
          </button>

          <div>
            <div className="flex items-center justify-between">
              <p className="text-sm font-bold text-slate-700">{t('本月大单奖记录')}</p>
              <span className="rounded-lg bg-amber-50 px-2 py-0.5 text-xs font-bold text-amber-600">
                {t('合计 ¥{amount}', { amount: yuan(totalCents) })}
              </span>
            </div>
            <div className="mt-2 max-h-56 divide-y divide-slate-50 overflow-y-auto rounded-2xl border border-slate-100">
              {rows.map((r) => {
                const canDelete =
                  ['developer', 'finance', 'admin'].includes(currentUser?.role) || r.createdBy === currentUser?.username
                return (
                <div key={r.id} className="flex items-center gap-3 px-3 py-2.5">
                  {r.receipt ? (
                    <img src={r.receipt} alt="小票" className="h-10 w-10 rounded-lg border border-slate-100 bg-white object-contain" />
                  ) : (
                    <span className="grid h-10 w-10 place-items-center rounded-lg bg-slate-50 text-slate-300">
                      <Award className="h-4 w-4" />
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold text-slate-700">
                      {t('订单 ¥{amount} → 奖金 ¥{bonus}', {
                        amount: yuan(r.amountCents),
                        bonus: yuan(r.bonusCents),
                      })}
                    </p>
                    <p className="mt-0.5 text-[10px] text-slate-400">
                      {r.date} · {new Date(r.createdAt).toLocaleString('zh-CN', { hour12: false })} · {r.createdBy}
                    </p>
                  </div>
                  {canDelete && (
                    <button
                      onClick={() => remove(r.id)}
                      className="rounded-lg p-1.5 text-slate-300 transition hover:bg-rose-50 hover:text-rose-500"
                      aria-label={t('删除')}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
                )
              })}
              {rows.length === 0 && <p className="grid place-items-center py-8 text-xs text-slate-300">{t('本月暂无大单奖记录')}</p>}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
