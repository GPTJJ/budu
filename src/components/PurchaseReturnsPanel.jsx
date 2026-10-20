import { useEffect, useRef, useState } from 'react';
import { api } from '../utils/api';
import { isProcurementDeveloper } from '../../shared/accountPermissions';

const btn = 'min-h-11 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold disabled:opacity-50';
const primary = btn + ' !bg-budu-500 !border-budu-500 !text-white';
const input = 'min-h-11 w-full min-w-0 rounded-xl border border-slate-200 bg-white p-3 text-sm';
const stateLabel = { PROCESSING: '处理中', PENDING: '待确认', COMPLETED: '已完成' };
const actionLabel = { CREATE: '新建', SAVE: '修改', SUBMIT: '提交确认', WITHDRAW: '撤回提交', RETURN: '退回修改', CONFIRM: '最终确认', REOPEN: '说明原因重开' };
const blankLine = replacement => ({ rowId: crypto.randomUUID(), itemId: '', quantity: '', unit: '', ...(replacement ? { storeKey: '', receivedDate: '', notes: '' } : {}) });
function Field({ label, children }) { return <label className="block min-w-0 space-y-1 text-sm"><span className="font-semibold">{label}</span>{children}</label>; }
function Facts({ content: c }) {
  if (!c) return null;
  return <div className="space-y-3 text-sm"><p className="break-words">供应商：{c.supplierNameSnapshot || '未填'}　来源门店：{c.storeNameSnapshot || '仅显示有权限的补货'}</p>
    {c.originalOrderId && <p className="break-all">关联采购单：{c.originalOrderId}</p>}
    {c.items.length > 0 && <div><p className="font-bold">实际退回 · {c.returnedDate || '日期未填'}</p>{c.items.map(l => <p className="mt-2 break-words" key={l.rowId}>{l.productNameSnapshot || '商品未填'}　{l.quantity || '数量未填'} {l.unit}</p>)}</div>}
    {c.reason && <p className="whitespace-pre-wrap break-words">原因：{c.reason}</p>}{c.notes && <p className="whitespace-pre-wrap break-words">备注：{c.notes}</p>}
    {c.replacements.length > 0 && <div><p className="font-bold">实际补货</p>{c.replacements.map(l => <div key={l.rowId} className="mt-2 rounded-xl bg-slate-50 p-3"><p className="break-words">{l.productNameSnapshot || '商品未填'}　{l.quantity || '数量未填'} {l.unit}</p><p className="mt-1 break-words">{l.storeNameSnapshot || '门店未填'} · {l.receivedDate || '日期未填'}</p>{l.notes && <p className="mt-1 whitespace-pre-wrap break-words">{l.notes}</p>}</div>)}</div>}
  </div>;
}

export default function PurchaseReturnsPanel({ currentUser, stores }) {
  const [rows, setRows] = useState([]), [options, setOptions] = useState({ suppliers: [], items: [] }), [detail, setDetail] = useState(null), [history, setHistory] = useState([]);
  const [edit, setEdit] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [why, setWhy] = useState(''), [reasonAction, setReasonAction] = useState('');
  const request = useRef(null), inFlight = useRef(false);
  const dev = isProcurementDeveloper(currentUser);
  const run = async fn => { if (inFlight.current) return; inFlight.current = true; setBusy(true); setError(''); try { await fn(); } catch (e) { setError(e.message); } finally { inFlight.current = false; setBusy(false); } };
  const load = async () => { const r = await api('/v2/procurement/returns'); setRows(r.rows); };
  const open = async id => { const r = await api('/v2/procurement/returns/' + id); setDetail(r.record); setHistory(r.history); setEdit(null); setReasonAction(''); };
  useEffect(() => { run(async () => { const o = await api('/v2/procurement/return-options'); setOptions(o); await load(); }); }, [currentUser.id]);
  const requestKey = body => { const value = JSON.stringify(body); if (request.current?.value !== value) request.current = { value, key: crypto.randomUUID() }; return request.current.key; };
  const save = () => run(async () => {
    const body = { content: edit.content, ...(edit.id ? { version: edit.version } : {}) };
    const r = await api('/v2/procurement/returns' + (edit.id ? '/' + edit.id + '/save' : ''), { method: 'POST', body: JSON.stringify({ ...body, requestKey: requestKey(body) }) });
    await open(r.record.id); await load(); setNotice('已保存处理中记录；未确认内容不计入事实汇总');
  });
  const act = action => run(async () => {
    const body = { id: detail.id, action, version: detail.version, ...(['return','reopen'].includes(action) ? { reason: why } : {}) };
    const r = await api('/v2/procurement/returns/' + detail.id + '/' + action, { method: 'POST', body: JSON.stringify({ version: detail.version, reason: body.reason, requestKey: requestKey(body) }) });
    await open(r.record.id); await load(); setWhy(''); setNotice(action === 'confirm' ? '当前提交版本已确认完成' : '记录已更新');
  });
  const begin = record => { setError(''); setNotice(''); setEdit(record ? { id: record.id, version: record.version, content: structuredClone(record.content) } : { content: { storeKey: stores.length === 1 ? stores[0].key : '', supplierId: '', originalOrderId: '', returnedDate: '', reason: '', notes: '', items: [blankLine(false)], replacements: [] } }); };
  const update = (field, value) => setEdit(e => ({ ...e, content: { ...e.content, [field]: value } }));
  const changeLine = (kind, index, field, value) => update(kind, edit.content[kind].map((l, i) => i === index ? { ...l, [field]: value } : l));
  const lineEditor = (kind, replacement) => <div className="space-y-3"><h4 className="font-bold">{replacement ? '实际补货（可不填写）' : '实际退回商品'}</h4>{edit.content[kind].map((l, i) => <fieldset key={l.rowId} className="min-w-0 space-y-3 rounded-2xl border border-slate-200 p-3"><legend className="px-1 text-sm">{replacement ? '补货' : '退货'}第{i + 1}项</legend>
    <Field label="商品"><select className={input} aria-label={`${replacement ? '补货' : '退货'}商品${i + 1}`} value={l.itemId} onChange={e => changeLine(kind,i,'itemId',e.target.value)}><option value="">选择商品</option>{l.itemId && !options.items.some(p => p.id === l.itemId) && <option value={l.itemId}>{l.productNameSnapshot}</option>}{options.items.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
    <div className="grid min-w-0 grid-cols-2 gap-3"><Field label="实际数量"><input className={input} inputMode="decimal" aria-label={`${replacement ? '补货' : '退货'}数量${i + 1}`} value={l.quantity} onChange={e => changeLine(kind,i,'quantity',e.target.value)} placeholder="未发生请留空" /></Field><Field label="单位"><input className={input} maxLength={20} aria-label={`${replacement ? '补货' : '退货'}单位${i + 1}`} value={l.unit} onChange={e => changeLine(kind,i,'unit',e.target.value)} placeholder="如：个、盒、克" /></Field></div>
    {replacement && <><Field label="补货接收门店"><select className={input} aria-label={`补货接收门店${i + 1}`} value={l.storeKey} onChange={e => changeLine(kind,i,'storeKey',e.target.value)}><option value="">选择可接收门店</option>{stores.filter(s => s.active === true || s.key === l.storeKey).map(s => <option key={s.key} value={s.key}>{s.name}{s.active === false ? '（已停用，仅保留原事实）' : ''}</option>)}</select></Field><Field label="实际补货日期"><input className={input} aria-label={`实际补货日期${i + 1}`} type="date" value={l.receivedDate} onChange={e => changeLine(kind,i,'receivedDate',e.target.value)} /></Field><Field label="补货备注"><textarea className={input} maxLength={2000} value={l.notes} onChange={e => changeLine(kind,i,'notes',e.target.value)} /></Field></>}
    <button type="button" className={btn} onClick={() => update(kind,edit.content[kind].filter((_,n) => n !== i))}>移除此项</button>
  </fieldset>)}<button type="button" className={btn} onClick={() => update(kind,[...edit.content[kind],blankLine(replacement)])}>追加{replacement ? '实际补货' : '退货商品'}</button></div>;
  return <section className="min-w-0 space-y-4">
    {error && <p role="alert" className="break-words rounded-xl bg-rose-50 p-3 text-rose-700">{error}</p>}{notice && <p role="status" className="rounded-xl bg-budu-50 p-3 text-sm">{notice}</p>}
    {edit ? <form onSubmit={e => { e.preventDefault(); save(); }} className="min-w-0 space-y-4 rounded-2xl bg-white p-4"><h3 className="text-lg font-bold">{edit.id ? '补充退货记录' : '新建退货记录'}</h3><p className="text-sm text-slate-500">只登记实际发生的退货、补货；可先保存未填完的内容。</p><fieldset disabled={busy} className="min-w-0 space-y-4">
      <Field label="退货来源门店"><select className={input} value={edit.content.storeKey} onChange={e => update('storeKey',e.target.value)}><option value="">选择来源门店</option>{stores.map(s => <option key={s.key} value={s.key}>{s.name}{s.active === false ? '（已停用，可登记历史退货）' : ''}</option>)}</select></Field>
      <Field label="供应商"><select className={input} value={edit.content.supplierId} onChange={e => update('supplierId',e.target.value)}><option value="">选择供应商</option>{options.suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
      <Field label="原采购单号（选填）"><input className={input} maxLength={100} value={edit.content.originalOrderId} onChange={e => update('originalOrderId',e.target.value)} placeholder="可不关联；多批次可在备注说明" /></Field>
      <Field label="实际退回日期"><input className={input} type="date" value={edit.content.returnedDate} onChange={e => update('returnedDate',e.target.value)} /></Field>
      {lineEditor('items',false)}<Field label="退货原因"><textarea className={input} maxLength={500} value={edit.content.reason} onChange={e => update('reason',e.target.value)} placeholder="如：质量问题、闭店清退" /></Field>
      {lineEditor('replacements',true)}<Field label="文字备注"><textarea className={input} maxLength={2000} value={edit.content.notes} onChange={e => update('notes',e.target.value)} /></Field>
      <div className="flex flex-wrap gap-2"><button className={primary} type="submit">保存处理中</button><button className={btn} type="button" onClick={() => setEdit(null)}>取消编辑</button></div>
    </fieldset></form> : detail ? <>
      <button className={btn} disabled={busy} onClick={() => { setDetail(null); setReasonAction(''); }}>返回退货列表</button>
      <article className="min-w-0 space-y-4 rounded-2xl border border-slate-100 bg-white p-4"><h3 className="break-all font-bold">{detail.number}</h3><p>{stateLabel[detail.status]} · 登记人 {detail.createdByName}</p>
        {detail.confirmedContent && detail.status !== 'COMPLETED' && <p className="rounded-xl bg-budu-50 p-3 text-sm">正在修订；历史查询和导出继续使用上次已确认事实。</p>}
        <Facts content={detail.content} />
        {detail.confirmedContent && detail.status !== 'COMPLETED' && <details className="rounded-xl border p-3"><summary className="cursor-pointer font-semibold">上次已确认事实</summary><div className="mt-3"><Facts content={detail.confirmedContent} /></div></details>}
        {detail.confirmedAt && <p className="text-sm text-slate-500">上次确认：{detail.confirmedByName} · {new Date(detail.confirmedAt).toLocaleString('zh-CN',{ timeZone:'Asia/Shanghai' })}</p>}
        {!detail.canEdit && <p className="text-sm text-slate-500">仅显示你有权限的门店明细；整单操作需覆盖全部相关门店权限。</p>}
        {detail.canEdit && <div className="flex flex-wrap gap-2">{detail.status === 'PROCESSING' && <><button disabled={busy} className={btn} onClick={() => begin(detail)}>修改／追加补货</button><button disabled={busy} className={primary} onClick={() => act('submit')}>提交用户确认</button></>}{detail.status === 'PENDING' && <><button disabled={busy} className={btn} onClick={() => act('withdraw')}>撤回提交</button>{dev && <><button disabled={busy} className={primary} onClick={() => act('confirm')}>确认当前版本完成</button><button disabled={busy} className={btn} onClick={() => { setWhy(''); setReasonAction('return'); }}>退回修改</button></>}</>}{detail.status === 'COMPLETED' && dev && <button disabled={busy} className={btn} onClick={() => { setWhy(''); setReasonAction('reopen'); }}>说明原因重开</button>}</div>}
        {reasonAction && <div className="space-y-3"><Field label={reasonAction === 'reopen' ? '重开原因' : '退回原因'}><textarea className={input} maxLength={500} value={why} onChange={e => setWhy(e.target.value)} /></Field><button className={primary} disabled={busy || !why.trim()} onClick={() => act(reasonAction)}>确认{reasonAction === 'reopen' ? '重开' : '退回'}</button><button className={btn + ' ml-2'} disabled={busy} onClick={() => setReasonAction('')}>取消</button></div>}
      </article>
      <section className="space-y-3"><h3 className="font-bold">修改与确认历史</h3>{history.map(h => <details className="rounded-xl border bg-white p-3 text-sm" key={h.id}><summary className="cursor-pointer break-words">{actionLabel[h.action.replace('RETURN_','')] || '记录更新'} · {h.actorName} · {new Date(h.createdAt).toLocaleString('zh-CN',{ timeZone:'Asia/Shanghai' })}</summary>{h.reason && <p className="my-2 break-words">原因：{h.reason}</p>}{h.before && <div className="mt-3 space-y-2"><p className="font-bold">修改前</p><Facts content={h.before.content} /></div>}{h.after && <div className="mt-3 space-y-2"><p className="font-bold">修改后</p><Facts content={h.after.content} /></div>}</details>)}</section>
    </> : <><div className="flex flex-wrap gap-2"><button className={primary} disabled={busy} onClick={() => begin()}>新建退货记录</button><button className={btn} disabled={busy} onClick={() => run(load)}>刷新退货记录</button></div><p className="text-sm text-slate-500">员工登记实际退回和可选补货，提交后由用户一次最终确认。</p>{!rows.length && !busy && <p className="rounded-2xl bg-white p-4">暂无有权限的退货记录。</p>}{rows.map(r => <button key={r.id} disabled={busy} onClick={() => run(() => open(r.id))} className="block w-full space-y-2 rounded-2xl border border-slate-100 bg-white p-4 text-left"><p className="break-words font-bold">{r.content.supplierNameSnapshot || '供应商未填'}</p><p className="text-sm">{r.content.storeNameSnapshot || '有权限的补货记录'} · {stateLabel[r.status]}</p><p className="break-all text-xs text-slate-500">{r.number}</p></button>)}</>}
  </section>;
}
