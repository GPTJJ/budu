import { useEffect, useRef, useState } from 'react';
import { api } from '../utils/api';
import { exportProcurementHistory, historyTypeLabels, historyStatusLabels, historyFilterDescription, historyFactNote } from '../utils/procurementHistoryExport';
const btn = 'min-h-11 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold disabled:opacity-50';
const input = 'min-h-11 w-full min-w-0 rounded-xl border border-slate-200 bg-white p-3 text-sm';
function Field({ label, children }) { return <label className="block min-w-0 space-y-1 text-sm"><span>{label}</span>{children}</label>; }
const PAGE_SIZE = 50;
export default function ProcurementHistoryPanel({ currentUser, stores }) {
  const today = new Date().toLocaleDateString('sv-SE',{ timeZone:'Asia/Shanghai' });
  const [filters,setFilters] = useState({ start: today.slice(0,7) + '-01', end: today, supplierId: '', storeKey: '', itemId: '', type: '', orderStatus: '', receiptStatus: '', returnStatus: '', keyword: '' });
  const [options,setOptions] = useState({ suppliers: [], items: [] }), [data,setData] = useState(null), [error,setError] = useState(''), [notice,setNotice] = useState(''), [busy,setBusy] = useState(false), [page,setPage] = useState(1), [view,setView] = useState('events');
  const pending = useRef(false);
  const run = async fn => { if (pending.current) return; pending.current = true; setBusy(true); setError(''); setNotice(''); try { await fn(); } catch (e) { setError(e.message); } finally { pending.current = false; setBusy(false); } };
  const query = async (f = filters) => { const result = await api('/v2/procurement/history?' + new URLSearchParams(f)); if (!result.complete) throw new Error('完整历史查询未完成，请重试'); setData(result); setPage(1); return result; };
  useEffect(() => { run(async () => { setOptions(await api('/v2/procurement/return-options')); await query(); }); }, [currentUser.id]);
  const change = (key,value) => setFilters(f => ({ ...f,[key]:value }));
  const select = (key,label,rows) => <Field label={label}><select className={input} value={filters[key]} onChange={e => change(key,e.target.value)}><option value="">全部</option>{rows.map(([value,name]) => <option key={value} value={value}>{name}</option>)}</select></Field>;
  const resultRows = data?.[view] || [], pageRows = resultRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  return <section className="min-w-0 space-y-4">
    <form onSubmit={e => { e.preventDefault(); run(() => query()); }} className="space-y-4 rounded-2xl border border-slate-100 bg-white p-4"><h3 className="font-bold">历史查询与 Excel 导出</h3>
      <fieldset disabled={busy} className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"><Field label="起始日期"><input className={input} type="date" value={filters.start} onChange={e => change('start',e.target.value)} /></Field><Field label="结束日期"><input className={input} type="date" value={filters.end} onChange={e => change('end',e.target.value)} /></Field>
        {select('supplierId','供应商',options.suppliers.map(s => [s.id,s.name]))}{select('storeKey','门店（含停用门店）',stores.map(s => [s.key,s.name + (s.active === false ? '（已停用）' : '')]))}{select('itemId','商品',options.items.map(s => [s.id,s.name]))}{select('type','记录类型',Object.entries(historyTypeLabels))}
        {select('orderStatus','采购单状态',['DRAFT','ORDERED','RECEIVING','CLOSED','CANCELLED'].map(k => [k,historyStatusLabels[k]]))}{select('receiptStatus','采购收货状态',['PENDING','APPROVED','RETURNED'].map(k => [k,historyStatusLabels[k]]))}{select('returnStatus','退货单状态',[['PROCESSING','处理中'],['PENDING','待确认'],['COMPLETED','已完成']])}
        <Field label="单号／关键词"><input className={input} value={filters.keyword} maxLength={200} onChange={e => change('keyword',e.target.value)} /></Field>
      </fieldset><div className="flex flex-wrap gap-2"><button disabled={busy} className={btn + ' !bg-budu-500 !text-white !border-budu-500'} type="submit">查询历史</button><button disabled={busy} className={btn} type="button" onClick={() => run(async () => { const result = await query(); const downloaded = await exportProcurementHistory(result); setNotice(downloaded.method === 'share-cancelled' ? '已取消分享；可再次下载' : `已生成全部 ${result.totalRows} 条匹配明细的 Excel`); })}>下载三表 Excel</button></div>
      <p className="text-xs leading-5 text-slate-500">按各业务实际发生日查询，包含起止日。三个状态条件分别筛选对应单据；未发生或日期、数量未填完整的草稿不进入事实明细。</p>
    </form>
    {error && <p role="alert" className="break-words rounded-xl bg-rose-50 p-3 text-rose-700">{error}</p>}{notice && <p role="status" className="rounded-xl bg-budu-50 p-3 text-sm">{notice}</p>}
    {data && <><div className="space-y-2 rounded-2xl bg-white p-4 text-sm"><p className="font-bold">查询结果：{data.filters.start || '不限'} 至 {data.filters.end || '不限'}（北京时间）</p><p className="break-words leading-6">{historyFilterDescription(data)}</p><p className="text-xs leading-5 text-slate-500">{historyFactNote}</p></div>
      <div className="flex flex-wrap gap-2">{[['summary','期间汇总'],['purchases','采购明细'],['events','收退货明细']].map(([key,label]) => <button disabled={busy} className={btn + (view === key ? ' !border-budu-500 !text-budu-600' : '')} key={key} onClick={() => { setView(key); setPage(1); }}>{label}（{data[key].length}）</button>)}</div>
      {pageRows.length === 0 && <p className="rounded-2xl bg-white p-4">此条件下没有匹配记录；仍可下载含表头的三表 Excel。</p>}
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">{pageRows.map((r,i) => <article key={r.id || i} className="min-w-0 space-y-2 rounded-2xl border border-slate-100 bg-white p-4 text-sm"><h4 className="break-words font-bold">{r.itemName} <span className="font-normal text-slate-500">{r.unit}</span></h4><p className="break-words">{r.supplierName} · {r.storeName}</p>{view === 'summary' ? <dl className="grid grid-cols-2 gap-2">{[['ordered','本期下单'],['received','本期实收'],['returned','本期退回'],['replacement','本期补货']].map(([key,label]) => <div key={key}><dt className="text-xs text-slate-500">{label}</dt><dd className="mt-1 font-bold">{r[key]} {r.unit}</dd></div>)}</dl> : <><p>{r.date || '尚未下单'} · {historyTypeLabels[r.type]} · {r.status}</p><p className="break-all text-xs text-slate-500">{r.number}</p>{r.relatedNumber && <p className="break-all text-xs text-slate-500">关联：{r.relatedNumber}</p>}<p className="font-bold">{view === 'purchases' ? '下单数量' : '本次数量'}：{r.quantity || '未填'} {r.unit}</p><p>登记人：{r.registeredBy || '—'}{r.confirmedBy ? ` · 确认人：${r.confirmedBy}` : ''}</p>{r.notes && <p className="whitespace-pre-wrap break-words text-slate-500">{r.notes}</p>}{!r.counted && <p className="text-xs text-rose-700">未确认／作废，不计入汇总</p>}</>}</article>)}</div>
      {resultRows.length > PAGE_SIZE && <div className="flex flex-wrap items-center gap-3"><button className={btn} disabled={page <= 1} onClick={() => setPage(p => p - 1)}>上一页</button><p className="text-sm">第 {page} / {Math.ceil(resultRows.length / PAGE_SIZE)} 页</p><button className={btn} disabled={page * PAGE_SIZE >= resultRows.length} onClick={() => setPage(p => p + 1)}>下一页</button><p className="text-xs text-slate-500">Excel 包含全部匹配明细。</p></div>}
    </>}
  </section>;
}
