import { useState } from 'react'
import { ArrowLeft, Check, PackagePlus, RefreshCcw, ShoppingCart, Trash2 } from 'lucide-react'
import { allStores, products } from '../utils/selectors'
import { getInventoryRequests, commitInventoryRequests } from '../utils/userData'
import { useI18n } from '../i18n'

const inputCls =
  'w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none transition focus:border-budu-400 focus:ring-2 focus:ring-budu-100'

export default function InventoryRequestPage({ type, currentUser, onBack }) {
  const { t } = useI18n()
  const isTransfer = type === 'transfer'
  const stores = allStores()
  const [form, setForm] = useState({
    fromStoreKey: stores[0] ? stores[0].key : '',
    storeKey: stores[1] ? stores[1].key : stores[0] ? stores[0].key : '',
    items: [{ productName: '', quantity: '', note: '' }],
    note: '',
  })
  const [error, setError] = useState('')
  const [savedTip, setSavedTip] = useState('')
  const [version, setVersion] = useState(0)

  const month = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`
  const productNames = [...new Set(products(month, 'all').map((p) => p.name))].slice(0, 100)
  const requests = getInventoryRequests().filter((r) => r.type === type)
  const isDeveloper = currentUser?.role === 'developer'

  const submit = () => {
    setError('')
    if (isTransfer && form.fromStoreKey === form.storeKey) {
      setError(t('调出门店和调入门店不能相同'))
      return
    }
    const items = form.items
      .map((it) => ({ ...it, productName: it.productName.trim(), quantity: it.quantity.trim() }))
      .filter((it) => it.productName || it.quantity || it.note.trim())
    if (items.length === 0) {
      setError(t('至少添加一种货品'))
      return
    }
    for (let i = 0; i < items.length; i += 1) {
      if (!items[i].productName) {
        setError(t('请填写第 {n} 行的商品名称', { n: i + 1 }))
        return
      }
      const qty = Number(items[i].quantity)
      if (!qty || qty < 1 || !Number.isFinite(qty)) {
        setError(t('请填写第 {n} 行的数量', { n: i + 1 }))
        return
      }
      items[i].quantity = Math.floor(qty)
    }
    const id =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `ir-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    commitInventoryRequests([
      ...getInventoryRequests(),
      {
        id,
        type,
        storeKey: form.storeKey,
        ...(isTransfer ? { fromStoreKey: form.fromStoreKey } : {}),
        items,
        note: form.note.trim(),
        status: 'pending',
        createdBy: currentUser?.username || '',
        createdAt: new Date().toISOString(),
      },
    ])
    setForm((s) => ({ ...s, items: [{ productName: '', quantity: '', note: '' }], note: '' }))
    setVersion((v) => v + 1)
    setSavedTip(t('已提交申请 ✓'))
    setTimeout(() => setSavedTip(''), 2200)
  }

  const remove = (r) => {
    if (!window.confirm(t('确定删除该申请吗？'))) return
    commitInventoryRequests(getInventoryRequests().filter((x) => x.id !== r.id))
    setVersion((v) => v + 1)
  }

  const canDelete = (r) => isDeveloper || r.createdBy === currentUser?.username

  return (
    <div className="space-y-6">
      {/* 页面头部 */}
      <div className="flex flex-wrap items-center gap-4">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 rounded-2xl bg-white px-3.5 py-2.5 text-sm font-medium text-slate-500 shadow-card transition hover:text-budu-600"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('返回首页')}
        </button>
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold text-slate-800">
            {isTransfer ? (
              <RefreshCcw className="h-5 w-5 text-budu-500" />
            ) : (
              <ShoppingCart className="h-5 w-5 text-grape-500" />
            )}
            {t(isTransfer ? '申请调货' : '申请采购')}
          </h2>
          <p className="mt-0.5 text-[13px] text-slate-400">
            {t(isTransfer ? '提交门店间调货申请，等待开发者处理' : '提交门店采购申请，等待开发者处理')}
          </p>
        </div>
        {savedTip && (
          <span className="ml-auto flex items-center gap-1 rounded-lg bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-600">
            <Check className="h-3.5 w-3.5" />
            {savedTip}
          </span>
        )}
      </div>

      {/* 申请表单 */}
      <div className="card p-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {isTransfer && (
            <div>
              <span className="mb-1.5 block text-xs font-semibold text-slate-500">{t('调出门店')}</span>
              <select
                value={form.fromStoreKey}
                onChange={(e) => setForm((s) => ({ ...s, fromStoreKey: e.target.value }))}
                className={inputCls}
              >
                {stores.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <span className="mb-1.5 block text-xs font-semibold text-slate-500">
              {t(isTransfer ? '调入门店' : '采购门店')}
            </span>
            <select
              value={form.storeKey}
              onChange={(e) => setForm((s) => ({ ...s, storeKey: e.target.value }))}
              className={inputCls}
            >
              {stores.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* 货品明细（支持多行） */}
        <div className="mt-5">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500">{t('货品明细')}</span>
            <button
              onClick={() =>
                setForm((s) => ({ ...s, items: [...s.items, { productName: '', quantity: '', note: '' }] }))
              }
              className="rounded-lg bg-budu-50 px-2.5 py-1 text-xs font-semibold text-budu-600 transition hover:bg-budu-100"
            >
              + {t('添加一行')}
            </button>
          </div>
          <div className="space-y-2">
            {form.items.map((row, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 rounded-2xl bg-slate-50/70 p-2.5">
                <span className="w-6 text-center text-[11px] font-bold text-slate-400">{i + 1}</span>
                <input
                  list="budu-inventory-products"
                  value={row.productName}
                  onChange={(e) => {
                    const next = [...form.items]
                    next[i] = { ...next[i], productName: e.target.value }
                    setForm((s) => ({ ...s, items: next }))
                  }}
                  placeholder={t('商品名称')}
                  className={`${inputCls} min-w-[160px] flex-1`}
                />
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={row.quantity}
                  onChange={(e) => {
                    const next = [...form.items]
                    next[i] = { ...next[i], quantity: e.target.value }
                    setForm((s) => ({ ...s, items: next }))
                  }}
                  placeholder={t('数量')}
                  className={`${inputCls} w-24`}
                />
                <input
                  value={row.note}
                  onChange={(e) => {
                    const next = [...form.items]
                    next[i] = { ...next[i], note: e.target.value }
                    setForm((s) => ({ ...s, items: next }))
                  }}
                  placeholder={t('备注')}
                  className={`${inputCls} min-w-[100px] flex-1`}
                />
                <button
                  onClick={() =>
                    setForm((s) => ({
                      ...s,
                      items: s.items.filter((_, idx) => idx !== i),
                    }))
                  }
                  disabled={form.items.length === 1}
                  className="rounded-lg p-2 text-slate-300 transition hover:bg-rose-50 hover:text-rose-500 disabled:cursor-not-allowed disabled:opacity-30"
                  aria-label={t('删除')}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
          <datalist id="budu-inventory-products">
            {productNames.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <input
            value={form.note}
            onChange={(e) => setForm((s) => ({ ...s, note: e.target.value }))}
            placeholder={t('整单备注（选填）')}
            className={`${inputCls} max-w-md flex-1`}
          />
          <button
            onClick={submit}
            className="flex items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-budu-500 to-grape-500 px-6 py-2.5 text-sm font-semibold text-white shadow-lg shadow-budu-200/60 transition hover:opacity-90"
          >
            <PackagePlus className="h-4 w-4" />
            {t('提交申请')}
          </button>
        </div>
        {error && <p className="mt-3 text-xs font-medium text-rose-500">{error}</p>}
      </div>

      {/* 申请列表 */}
      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-5 py-4">
          <h3 className="text-[15px] font-bold text-slate-800">{t('申请列表')}</h3>
          <span className="rounded-lg bg-budu-50 px-2 py-0.5 text-xs font-semibold text-budu-600">
            {requests.length}
          </span>
        </div>
        <div className="divide-y divide-slate-50">
          {requests.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
              <span
                className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold ${
                  r.status === 'done' ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'
                }`}
              >
                {t(r.status === 'done' ? '已完成' : '待处理')}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-slate-700">
                  {t('{count} 种货品', { count: r.items ? r.items.length : 1 })}
                </p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {(r.items || [{ productName: r.productName, quantity: r.quantity }]).map((it, idx) => (
                    <span
                      key={idx}
                      className="rounded-md bg-budu-50 px-1.5 py-0.5 text-[11px] font-semibold text-budu-600"
                    >
                      {it.productName} × {it.quantity}
                      {it.note ? `（${it.note}）` : ''}
                    </span>
                  ))}
                </div>
                <p className="mt-0.5 text-[11px] text-slate-400">
                  {isTransfer
                    ? t('从 {from} 调往 {to}', {
                        from: stores.find((s) => s.key === r.fromStoreKey)?.name || r.fromStoreKey,
                        to: stores.find((s) => s.key === r.storeKey)?.name || r.storeKey,
                      })
                    : t('采购至 {store}', {
                        store: stores.find((s) => s.key === r.storeKey)?.name || r.storeKey,
                      })}
                  {r.note ? ` · ${r.note}` : ''}
                </p>
                <p className="mt-0.5 text-[11px] text-slate-300">
                  {t('由 {name} 提交', { name: r.createdBy })} · {new Date(r.createdAt).toLocaleString()}
                </p>
              </div>
              {canDelete(r) && (
                <button
                  onClick={() => remove(r)}
                  className="rounded-lg p-2 text-slate-300 transition hover:bg-rose-50 hover:text-rose-500"
                  aria-label={t('删除')}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
          {requests.length === 0 && (
            <p className="grid place-items-center py-14 text-sm text-slate-300">{t('暂无申请，填写左侧表单提交')}</p>
          )}
        </div>
      </div>
    </div>
  )
}
