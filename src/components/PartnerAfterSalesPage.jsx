import { useEffect, useState } from 'react'
import { ArrowLeft, RefreshCw } from 'lucide-react'
import { api } from '../utils/api'

const typeLabel = { DAMAGED: '破损', WRONG_ITEM: '错发', RETURN: '退货' }
const statusLabel = { PENDING: '待处理', PROCESSING: '处理中', RESOLVED: '已解决', REJECTED: '已拒绝' }
const quantityLabel = (row) => row.orderUnit === 'KG' ? `${row.quantityBase / 1000} kg` : `${row.quantityBase} ${row.orderUnit === 'PCS' ? '颗' : row.nativeUnit || '单位'}`

export default function PartnerAfterSalesPage({ onBack }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reason, setReason] = useState({})
  const [preview, setPreview] = useState(null)
  const load = async () => { setLoading(true); setError(''); try { const data = await api('/v2/partner-management/after-sales'); setRows(data.rows || []) } catch (nextError) { setError(nextError.data?.message || nextError.message) } finally { setLoading(false) } }
  useEffect(() => { load() }, [])
  const process = async (row, status) => {
    setError('')
    try { await api(`/v2/partner-management/after-sales/${row.id}/process`, { method: 'POST', body: JSON.stringify({ status, reason: reason[row.id] || '', version: row.version }) }); await load() } catch (nextError) { setError(nextError.data?.message || nextError.message) }
  }
  const viewAttachment = async (row, attachment) => {
    setError('')
    try { const data = await api(`/v2/partner-management/after-sales/${row.id}/attachments/${attachment.id}`); setPreview(data.attachment) } catch (nextError) { setError(nextError.data?.message || nextError.message) }
  }
  return <section className="min-w-0 space-y-4" data-testid="partner-after-sales-page"><header className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-3"><button type="button" onClick={onBack} className="grid h-11 w-11 place-items-center rounded-xl border border-slate-200 bg-white"><ArrowLeft className="h-5 w-5" /></button><div><p className="text-xs font-black tracking-[0.12em] text-budu-500">PARTNER AFTER-SALES</p><h2 className="text-xl font-black text-slate-900">售后处理</h2></div></div><button type="button" onClick={load} className="btn-secondary min-h-11"><RefreshCw className="h-4 w-4" />刷新</button></header>{error && <p role="alert" className="rounded-xl bg-rose-50 p-4 text-sm font-semibold text-rose-700">{error}</p>}{loading ? <div className="card p-8 text-center text-slate-400">加载售后申请…</div> : rows.length === 0 ? <div className="card p-10 text-center text-slate-400">暂无售后申请</div> : <div className="grid gap-4 lg:grid-cols-2">{rows.map((row) => <article key={row.id} className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm"><div className="flex items-start justify-between gap-3"><div><p className="font-black text-slate-800">{row.requestNo}</p><p className="mt-1 text-xs text-slate-400">{row.partnerName} · {row.orderNo}</p></div><span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-black text-amber-700">{statusLabel[row.status]}</span></div><p className="mt-3 text-sm font-bold text-slate-700">{typeLabel[row.type]} · {row.productName} · {quantityLabel(row)}</p><p className="mt-2 text-sm text-slate-500">{row.description}</p>{row.attachments?.length > 0 && <div className="mt-2 flex flex-wrap gap-2">{row.attachments.map((attachment) => <button key={attachment.id} type="button" onClick={() => viewAttachment(row, attachment)} className="min-h-10 rounded-xl bg-sky-50 px-3 text-xs font-bold text-sky-700">查看图片：{attachment.name}</button>)}</div>}{row.resultNote && <p className="mt-2 rounded-xl bg-slate-50 p-3 text-sm text-slate-600">处理记录：{row.resultNote}</p>}{['PENDING', 'PROCESSING'].includes(row.status) && <div className="mt-4 space-y-3"><textarea aria-label={`${row.requestNo}处理说明`} value={reason[row.id] || ''} onChange={(event) => setReason((value) => ({ ...value, [row.id]: event.target.value }))} placeholder="填写合作商可见的处理说明" className="min-h-20 w-full rounded-xl border border-slate-200 p-3 text-sm" /><div className="grid grid-cols-2 gap-2">{row.status === 'PENDING' ? <button type="button" disabled={!reason[row.id]?.trim()} onClick={() => process(row, 'PROCESSING')} className="btn-primary min-h-11 disabled:opacity-40">开始处理</button> : <button type="button" disabled={!reason[row.id]?.trim()} onClick={() => process(row, 'RESOLVED')} className="btn-primary min-h-11 disabled:opacity-40">标记解决</button>}<button type="button" disabled={!reason[row.id]?.trim()} onClick={() => process(row, 'REJECTED')} className="min-h-11 rounded-xl bg-rose-50 font-bold text-rose-700 disabled:opacity-40">拒绝申请</button></div></div>}</article>)}</div>}{preview && <div role="dialog" aria-label="售后图片预览" className="fixed inset-0 z-[90] grid place-items-center bg-slate-950/70 p-4" onClick={() => setPreview(null)}><img src={preview.dataUrl} alt={preview.name} className="max-h-[85dvh] max-w-full rounded-2xl bg-white" /></div>}<p className="rounded-2xl border border-dashed border-slate-200 p-4 text-xs leading-5 text-slate-400">售后处理仅记录事实、状态与结果；不会自动退款、创建支付记录、退回库存或写入 StockLedger。</p></section>
}
