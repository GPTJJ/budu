import { useEffect, useState } from 'react'
import { Check, Plus, Trash2, Truck, X } from 'lucide-react'
import { resolveItemCategory } from '../utils/itemCategory'
import { t } from '../utils/text'

function newRow() {
  return {
    key: `row-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    productName: '',
    quantity: 1,
    note: '',
    isNew: true,
  }
}

export default function ShipTransferModal({ request, catalog = [], storeDisplay, onClose, onConfirm }) {
  const [rows, setRows] = useState(() => {
    const source = Array.isArray(request.items) && request.items.length > 0 ? request.items : []
    return source.length > 0
      ? source.map((it, i) => ({
          key: it.id || `row-${i}`,
          productName: it.productName || '',
          quantity: Number(it.quantity) || 1,
          note: it.note || '',
          isNew: false,
        }))
      : [newRow()]
  })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  const updateRow = (key, patch) => {
    setRows((list) => list.map((r) => (r.key === key ? { ...r, ...patch } : r)))
    setError('')
  }

  const removeRow = (key) => {
    setRows((list) => list.filter((r) => r.key !== key))
    setError('')
  }

  const handleConfirm = async () => {
    if (rows.length === 0) {
      setError(t('至少保留一种货品'))
      return
    }
    for (const r of rows) {
      const name = String(r.productName || '').trim()
      const qty = Number(r.quantity)
      if (!name) {
        setError(t('货品名称不能为空'))
        return
      }
      if (!Number.isInteger(qty) || qty < 1 || qty > 999999) {
        setError(t('数量应为 1-999999 的整数'))
        return
      }
    }
    setBusy(true)
    try {
      await onConfirm(
        rows.map((r) => ({
          name: String(r.productName).trim(),
          quantity: Number(r.quantity),
          note: r.note,
          category: resolveItemCategory(r.productName, ''),
        })),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-200/70 bg-white shadow-lg">
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
          <div>
            <h3 className="flex items-center gap-2 text-base font-semibold text-slate-900">
              <Truck className="h-4 w-4 text-blue-500" />
              {t('发货编辑')}
            </h3>
            <p className="mt-1 text-xs text-slate-400">
              {t('从 {from} 调往 {to}', {
                from: storeDisplay(request.fromStoreKey, request.fromStoreName),
                to: storeDisplay(request.storeKey, request.storeName),
              })}
              {request.note ? ` · ${request.note}` : ''}
              {' · '}
              {t('由 {name} 提交', { name: request.createdBy })}
            </p>
          </div>
          <button
            onClick={onClose}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-slate-50 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
            aria-label={t('关闭')}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <p className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700">
            {t('可修改数量、备注，也可新增或删除货品；确认发货后以修改后的清单为准')}
          </p>

          <div className="overflow-x-auto rounded-xl border border-slate-100">
            <table className="w-full min-w-[620px] text-left text-sm">
              <thead>
                <tr className="bg-slate-50/80 text-xs text-slate-400">
                  <th className="px-3 py-2.5 font-semibold">{t('货品名称')}</th>
                  <th className="w-32 px-3 py-2.5 font-semibold">{t('数量')}</th>
                  <th className="px-3 py-2.5 font-semibold">{t('备注')}</th>
                  <th className="w-12 px-3 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {rows.map((r) => (
                  <tr key={r.key} className="hover:bg-slate-50/50">
                    <td className="px-3 py-2">
                      <input
                        list={r.isNew ? 'budu-ship-catalog' : undefined}
                        value={r.productName}
                        onChange={(e) => updateRow(r.key, { productName: e.target.value })}
                        readOnly={!r.isNew}
                        placeholder={t('输入或选择货品')}
                        className={`input ${r.isNew ? '' : 'bg-slate-50 text-slate-500'}`}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="number"
                        min="1"
                        step="1"
                        value={r.quantity}
                        onChange={(e) => updateRow(r.key, { quantity: e.target.value })}
                        className="input"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        value={r.note}
                        onChange={(e) => updateRow(r.key, { note: e.target.value })}
                        placeholder={t('选填')}
                        className="input"
                      />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => removeRow(r.key)}
                        className="rounded-lg p-1.5 text-slate-300 transition hover:bg-rose-50 hover:text-rose-500"
                        aria-label={t('删除')}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <datalist id="budu-ship-catalog">
              {catalog.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          </div>

          <button
            type="button"
            onClick={() => setRows((list) => [...list, newRow()])}
            className="mt-3 flex items-center gap-1.5 rounded-lg border border-dashed border-budu-200 px-3 py-2 text-xs font-semibold text-budu-500 transition hover:bg-budu-50"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('添加货品')}
          </button>

          {error && <p className="mt-3 text-xs font-medium text-rose-500">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-5 py-3">
          <button onClick={onClose} className="btn-secondary px-4 py-2">
            {t('取消')}
          </button>
          <button onClick={handleConfirm} disabled={busy} className="btn-primary px-4 py-2">
            <Check className="h-4 w-4" />
            {busy ? t('提交中…') : t('确认发货')}
          </button>
        </div>
      </div>
    </div>
  )
}
