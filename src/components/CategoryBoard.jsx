import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, Pencil, RefreshCw } from 'lucide-react'
import { api } from '../utils/api'

/**
 * 商品 → 分类管理（线上分类）
 *
 * 分类只决定小程序商品分组与排序；商品发布时会把分类名写进商品文档，
 * 因此这里保存后无需单独「发布分类」。
 */

const inputClass = 'w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-budu-300'

function fmtDate(value) {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export default function CategoryBoard() {
  const [categories, setCategories] = useState([])
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [form, setForm] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [catRes, prodRes] = await Promise.all([
        api('/v2/online-catalog/categories'),
        api('/v2/online-catalog/products'),
      ])
      setCategories(catRes.categories || [])
      setProducts(prodRes.products || [])
    } catch (err) {
      setError(err.message || '加载分类失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const counts = useMemo(() => {
    const map = new Map()
    for (const product of products) {
      const key = product.onlineCategoryId || ''
      map.set(key, (map.get(key) || 0) + 1)
    }
    return map
  }, [products])

  const save = async () => {
    if (!form) return
    setBusy(true)
    setError('')
    try {
      const payload = {
        name: form.name,
        sortOrder: Number(form.sortOrder) || 0,
        isActive: form.isActive !== false,
      }
      if (form.id) {
        await api(`/v2/online-catalog/categories/${form.id}`, { method: 'PUT', body: JSON.stringify(payload) })
        setNotice('分类已更新；已发布商品的分类名会在下次发布时同步。')
      } else {
        await api('/v2/online-catalog/categories', { method: 'POST', body: JSON.stringify(payload) })
        setNotice('分类已创建。')
      }
      setForm(null)
      await load()
    } catch (err) {
      setError(err.message || '保存分类失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
        <div className="flex gap-2">
          <button type="button" onClick={load} className="inline-flex h-9 flex-1 items-center justify-center gap-1 rounded-xl border border-slate-200 px-3 text-sm text-slate-600 hover:bg-slate-50 sm:h-8 sm:flex-none">
            <RefreshCw size={14} /> 刷新
          </button>
          <button type="button" onClick={() => setForm({ name: '', sortOrder: categories.length, isActive: true })} className="inline-flex h-9 flex-1 items-center justify-center gap-1 rounded-xl bg-budu-500 px-4 text-sm font-semibold text-white disabled:opacity-50 sm:h-8 sm:flex-none">
            <Plus size={15} /> 新增分类
          </button>
        </div>
      </div>

      {error ? <div className="mb-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-700">{error}</div> : null}
      {notice ? <div className="mb-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-xs text-emerald-700">{notice}</div> : null}

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full min-w-[640px]">
            <thead>
              <tr className="border-b border-slate-100 bg-[#FEFDFC] text-left text-[11px] text-slate-500">
                <th className="px-4 py-2.5 font-medium">分类名称</th>
                <th className="w-[90px] px-3 py-2.5 font-medium">排序</th>
                <th className="w-[110px] px-3 py-2.5 font-medium">商品数</th>
                <th className="w-[110px] px-3 py-2.5 font-medium">状态</th>
                <th className="w-[120px] px-3 py-2.5 font-medium">更新时间</th>
                <th className="w-[90px] px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6}><div className="px-4 py-14 text-center text-xs text-slate-400">加载中…</div></td></tr>
              ) : !categories.length ? (
                <tr><td colSpan={6}><div className="px-4 py-14 text-center text-xs text-slate-400">还没有线上分类</div></td></tr>
              ) : categories.map((category) => (
                <tr key={category.id} className="border-b border-slate-100 last:border-0 hover:bg-[#FEFCFB]">
                  <td className="px-4 py-3 text-sm font-medium text-slate-700">{category.name}</td>
                  <td className="px-3 py-3 text-xs text-slate-500">{category.sortOrder}</td>
                  <td className="px-3 py-3 text-xs text-slate-600">{counts.get(category.id) || 0}</td>
                  <td className="px-3 py-3">
                    <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] ${category.isActive ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-100 text-slate-500 border-slate-200'}`}>
                      {category.isActive ? '启用' : '停用'}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-[11px] text-slate-400">{fmtDate(category.updatedAt)}</td>
                  <td className="px-4 py-3 text-right">
                    <button type="button" onClick={() => setForm({ ...category })} className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 px-2.5 text-xs text-slate-600 hover:bg-slate-50">
                      <Pencil size={12} /> 编辑
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="divide-y divide-slate-100 md:hidden">
          {loading ? (
            <div className="px-4 py-14 text-center text-xs text-slate-400">加载中…</div>
          ) : !categories.length ? (
            <div className="px-4 py-14 text-center text-xs text-slate-400">还没有线上分类</div>
          ) : categories.map((category) => (
            <button key={category.id} type="button" onClick={() => setForm({ ...category })} className="block w-full px-4 py-3 text-left active:bg-slate-50">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-700">{category.name}</span>
                <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${category.isActive ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-100 text-slate-500 border-slate-200'}`}>
                  {category.isActive ? '启用' : '停用'}
                </span>
              </div>
              <div className="mt-1 text-[11px] text-slate-400">排序 {category.sortOrder} · {counts.get(category.id) || 0} 个商品</div>
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2.5 text-[11px] text-slate-400">
          <span>共 {categories.length} 个分类</span>
          <span>分类排序影响小程序商品分组顺序</span>
        </div>
      </div>

      {form ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4">
          <div className="mt-10 w-full max-w-md rounded-2xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
              <div className="text-sm font-semibold text-slate-800">{form.id ? '编辑分类' : '新增分类'}</div>
              <button type="button" onClick={() => setForm(null)} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-50">✕</button>
            </div>
            <div className="space-y-3 px-5 py-4">
              <label className="block text-xs text-slate-500">
                分类名称
                <input className={`mt-1 ${inputClass}`} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} maxLength={20} />
              </label>
              <label className="block text-xs text-slate-500">
                排序值（越小越靠前）
                <input className={`mt-1 ${inputClass}`} type="number" value={form.sortOrder} onChange={(e) => setForm((f) => ({ ...f, sortOrder: e.target.value }))} />
              </label>
              <label className="block text-xs text-slate-500">
                状态
                <select className={`mt-1 ${inputClass}`} value={form.isActive === false ? 'false' : 'true'} onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.value === 'true' }))}>
                  <option value="true">启用</option>
                  <option value="false">停用</option>
                </select>
              </label>
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3">
              <button type="button" onClick={() => setForm(null)} className="h-9 rounded-xl border border-slate-200 px-4 text-sm text-slate-600">取消</button>
              <button type="button" onClick={save} disabled={busy || !form.name.trim()} className="h-9 rounded-xl bg-budu-500 px-4 text-sm font-semibold text-white disabled:opacity-50">保存</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
