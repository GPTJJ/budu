import { useEffect, useState } from 'react'
import { api } from '../utils/api'

export default function PurchaseRollbackHistoryPage({ onBack = () => {} }) {
  const [rows, setRows] = useState([])
  const [suppliers, setSuppliers] = useState([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let active = true
    Promise.all([api('/v2/purchase-requests'), api('/v2/suppliers')])
      .then(([orders, partners]) => {
        if (active) { setRows(orders.rows || []); setSuppliers(partners.rows || []) }
      })
      .catch(e => { if (active) setError(e.message) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])
  return <section className="mx-auto max-w-5xl space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-xl font-black text-slate-800">采购历史</h2>
      <button className="min-h-11 rounded-xl border border-slate-200 bg-white px-4 py-2" onClick={onBack}>返回</button>
    </div>
    <p className="rounded-2xl bg-rose-50 p-4 text-slate-700">采购操作暂时停用。旧采购历史可查看，新采购与收货记录已保留，恢复后可继续处理。</p>
    {error && <p role="alert" className="break-words rounded-xl bg-rose-50 p-3 text-rose-700">{error}</p>}
    {loading ? <p role="status">加载历史记录</p> : <>
      {!rows.length && <p className="rounded-xl bg-white p-4 text-slate-500">暂无旧采购记录</p>}
      {rows.map(row => <article key={row.id} className="rounded-2xl border border-slate-200 bg-white p-4">
        <h3 className="break-words font-bold text-slate-800">{row.supplier || '旧供应商未记录'}</h3>
        <p className="mt-1 break-words text-sm text-slate-600">{row.storeName || row.storeKey} · {row.status === 'received' ? '旧流程已收货' : row.status === 'pending' ? '旧流程待处理' : row.status}</p>
        {(row.items || []).map(item => <div key={item.id} className="mt-3 rounded-xl bg-slate-50 p-3">
          <p className="break-words font-semibold">{item.productName || '旧商品名称未记录'}</p>
          <p className="mt-1 break-words text-sm">原要货 {item.quantity} {item.unit} · 旧实收 {item.receivedQty} {item.unit}</p>
        </div>)}
      </article>)}
      <details className="rounded-2xl border border-slate-200 bg-white p-4">
        <summary className="min-h-11 cursor-pointer font-semibold">旧供应商资料</summary>
        {suppliers.map(supplier => <p key={supplier.id} className="mt-2 break-words text-slate-700">{supplier.name}</p>)}
        {!suppliers.length && <p className="mt-2 text-slate-500">暂无旧供应商</p>}
      </details>
    </>}
  </section>
}
