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
function SupplierProducts({ supplierId, products, lines, replacement, targetLabel, onCancel, onAdd }) {
  const [search, setSearch] = useState(''), [selected, setSelected] = useState([]);
  const label = replacement ? '补货' : '退货';
  const available = supplierId ? products.filter(p => p.procurementSupplierId === supplierId) : [];
  const matches = available.filter(p => p.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const slots = targetLabel ? 1 : (replacement ? 200 : 100) - lines.length;
  const remaining = matches.filter(p => !selected.includes(p.id));
  return <div className="min-w-0 space-y-3 rounded-2xl border border-budu-100 bg-budu-50/40 p-3" role="group" aria-label={`${label}货品选择`}>
    {targetLabel && <div className="flex flex-wrap items-center gap-2"><p className="min-w-0 flex-1 text-sm font-semibold" role="status">为{targetLabel}选择一件货品，保留该行已填内容。</p><button type="button" className={btn} onClick={onCancel}>取消重选</button></div>}
    {!supplierId ? <p className="text-sm text-slate-500">请先选择供应商，再勾选{label}货品。</p> : !available.length ? <p className="text-sm text-slate-500">该供应商暂无关联货品；已有明细会保留。</p> : <>
      <Field label={`搜索${label}货品`}><input className={input} type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="输入货品名称" /></Field>
      <div className="flex flex-wrap items-center gap-2 text-sm"><p className="mr-auto text-slate-500">可选 {available.length} 件 · 已勾选 {selected.length} 件</p>{!targetLabel && <button className={btn} type="button" disabled={!remaining.length || selected.length + remaining.length > slots} onClick={() => setSelected([...selected, ...remaining.map(p => p.id)])}>全选当前结果</button>}{selected.length > 0 && <button className={btn} type="button" onClick={() => setSelected([])}>清空勾选</button>}</div>
      <div className="grid max-h-72 min-w-0 grid-cols-1 gap-2 overflow-y-auto overscroll-contain sm:grid-cols-2">
        {matches.map(p => <label key={p.id} className={`flex min-h-12 min-w-0 cursor-pointer items-start gap-3 rounded-xl border bg-white p-3 ${selected.includes(p.id) ? 'border-budu-500 ring-1 ring-budu-200' : 'border-slate-200'}`}>
          <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-budu-600" checked={selected.includes(p.id)} disabled={!selected.includes(p.id) && selected.length >= slots} onChange={e => setSelected(e.target.checked ? [...selected, p.id] : selected.filter(id => id !== p.id))} />
          <span className="min-w-0 break-words text-sm font-semibold leading-6">{p.name}</span>
        </label>)}
      </div>
      {!matches.length && <p className="text-sm text-slate-500">未找到匹配货品。</p>}
      {!targetLabel && selected.length + remaining.length > slots && <p className="text-sm text-slate-500">本单最多{replacement ? 200 : 100}条{label}明细，还可添加 {Math.max(0, slots)} 件，请逐件勾选。</p>}
      <button type="button" className={primary + ' w-full sm:w-auto'} disabled={!selected.length || selected.length > slots} onClick={() => { onAdd(available.filter(p => selected.includes(p.id))); setSelected([]); }}>{targetLabel ? '确认选择' : '添加所选'}{label}货品（{selected.length}）</button>
      {!targetLabel && <p className="text-xs leading-5 text-slate-500">可一次勾选多件；添加后填写实际数量和单位。同一货品可再次添加，分别记录不同批次。</p>}
    </>}
  </div>;
}
function Facts({ content: c }) {
  if (!c) return null;
  return <div className="space-y-3 text-sm"><p className="break-words">供应商：{c.supplierNameSnapshot || '未填'}　来源门店：{c.storeNameSnapshot || '仅显示有权限的补货'}</p>
    {c.originalOrderId && <p className="break-all">关联采购单：{c.originalOrderId}</p>}
    {c.items.length > 0 && <div><p className="font-bold">实际退回 · {c.returnedDate || '日期未填'}</p>{c.items.map(l => <p className="mt-2 break-words" key={l.rowId}>{l.productNameSnapshot || '商品未填'}　{l.quantity || '数量未填'} {l.unit}</p>)}</div>}
    {c.reason && <p className="whitespace-pre-wrap break-words">原因：{c.reason}</p>}{c.notes && <p className="whitespace-pre-wrap break-words">备注：{c.notes}</p>}
    {c.replacements.length > 0 && <div><p className="font-bold">实际补货</p>{c.replacements.map(l => <div key={l.rowId} className="mt-2 rounded-xl bg-slate-50 p-3"><p className="break-words">{l.productNameSnapshot || '商品未填'}　{l.quantity || '数量未填'} {l.unit}</p><p className="mt-1 break-words">{l.storeNameSnapshot || '门店未填'} · {l.receivedDate || '日期未填'}</p>{l.notes && <p className="mt-1 whitespace-pre-wrap break-words">{l.notes}</p>}</div>)}</div>}
  </div>;
}

export default function PurchaseReturnsPanel({ currentUser, stores, originalOrderId = '' }) {
  const [rows, setRows] = useState([]), [options, setOptions] = useState({ suppliers: [], items: [] }), [detail, setDetail] = useState(null), [history, setHistory] = useState([]);
  const [edit, setEdit] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [why, setWhy] = useState(''), [reasonAction, setReasonAction] = useState('');
  const [selectionTarget, setSelectionTarget] = useState({});
  const request = useRef(null), inFlight = useRef(false);
  const dev = isProcurementDeveloper(currentUser);
  const run = async fn => { if (inFlight.current) return; inFlight.current = true; setBusy(true); setError(''); try { await fn(); } catch (e) { setError(e.message); } finally { inFlight.current = false; setBusy(false); } };
  const load = async () => { const r = await api('/v2/procurement/returns'); setRows(r.rows); };
  const open = async id => { const r = await api('/v2/procurement/returns/' + id); setDetail(r.record); setHistory(r.history); setEdit(null); setSelectionTarget({}); setReasonAction(''); };
  useEffect(() => { run(async () => {
    const o = await api('/v2/procurement/return-options'); setOptions(o); await load();
    if (originalOrderId) {
      const template = await api('/v2/procurement/orders/' + encodeURIComponent(originalOrderId) + '/return-template');
      setEdit({ content: template.content });
      setSelectionTarget({});
      setNotice('已带入原采购单商品及单位，请移除不退项目，并填写实际退回数量、日期和原因。');
    }
  }); }, [currentUser.id, originalOrderId]);
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
  const begin = record => { setError(''); setNotice(''); setSelectionTarget({}); setEdit(record ? { id: record.id, version: record.version, content: structuredClone(record.content) } : { content: { storeKey: stores.length === 1 ? stores[0].key : '', supplierId: '', originalOrderId: '', returnedDate: '', reason: '', notes: '', items: [], replacements: [] } }); };
  const update = (field, value) => setEdit(e => ({ ...e, content: { ...e.content, [field]: value } }));
  const changeLine = (kind, index, field, value) => update(kind, edit.content[kind].map((l, i) => i === index ? { ...l, [field]: value } : l));
  const addProducts = (kind, replacement, products) => { setEdit(e => {
    const lines = [...e.content[kind]];
    const target = selectionTarget[kind];
    if (target) {
      // The exact row carries historical store eligibility. Never guess which
      // unfinished row a product belongs to or regenerate its stable rowId.
      const index = lines.findIndex(l => l.rowId === target);
      if (index === -1 || products.length !== 1) return e;
      const p = products[0], previous = lines[index];
      lines[index] = { ...previous, itemId: p.id, productNameSnapshot: previous.itemId === p.id ? previous.productNameSnapshot : p.name };
    } else for (const p of products) {
      if (lines.length < (replacement ? 200 : 100)) lines.push({ ...blankLine(replacement), itemId: p.id, productNameSnapshot: p.name });
    }
    return { ...e, content: { ...e.content, [kind]: lines } };
  }); setSelectionTarget(t => ({ ...t, [kind]: null })); };
  const lineEditor = (kind, replacement) => <div className="space-y-3"><h4 className="font-bold">{replacement ? '实际补货（可不填写）' : '实际退回商品'}</h4>
    <SupplierProducts key={`${kind}:${edit.content.supplierId}:${selectionTarget[kind] || ''}`} supplierId={edit.content.supplierId} products={options.items} lines={edit.content[kind]} replacement={replacement} targetLabel={selectionTarget[kind] ? `${replacement ? '补货' : '退货'}第${edit.content[kind].findIndex(l => l.rowId === selectionTarget[kind]) + 1}项` : ''} onCancel={() => setSelectionTarget(t => ({ ...t, [kind]: null }))} onAdd={products => addProducts(kind, replacement, products)} />
    {edit.content[kind].map((l, i) => <fieldset key={l.rowId} className="min-w-0 space-y-3 rounded-2xl border border-slate-200 p-3"><legend className="px-1 text-sm">{replacement ? '补货' : '退货'}第{i + 1}项</legend>
    <div className="min-w-0 space-y-1"><p className="text-sm font-semibold">商品</p><p className="break-words font-bold">{l.productNameSnapshot || options.items.find(p => p.id === l.itemId)?.name || '待选择商品'}</p>{!l.itemId ? <p className="text-xs text-slate-500">点击「选择此行货品」，保留此行已有数量、单位和门店。</p> : !options.items.some(p => p.id === l.itemId && p.procurementSupplierId === edit.content.supplierId) && <p className="text-xs text-slate-500">该货品当前未关联此供应商，已填明细仍保留，请核对。</p>}</div>
    <div className="grid min-w-0 grid-cols-2 gap-3"><Field label="实际数量"><input className={input} inputMode="decimal" aria-label={`${replacement ? '补货' : '退货'}数量${i + 1}`} value={l.quantity} onChange={e => changeLine(kind,i,'quantity',e.target.value)} placeholder="未发生请留空" /></Field><Field label="单位"><input className={input} maxLength={20} aria-label={`${replacement ? '补货' : '退货'}单位${i + 1}`} value={l.unit} onChange={e => changeLine(kind,i,'unit',e.target.value)} placeholder="如：个、盒、克" /></Field></div>
    {replacement && <><Field label="补货接收门店"><select className={input} aria-label={`补货接收门店${i + 1}`} value={l.storeKey} onChange={e => changeLine(kind,i,'storeKey',e.target.value)}><option value="">选择可接收门店</option>{stores.filter(s => s.active === true || s.key === l.storeKey).map(s => <option key={s.key} value={s.key}>{s.name}{s.active === false ? '（已停用，仅维护已有事实）' : ''}</option>)}</select></Field><Field label="实际补货日期"><input className={input} aria-label={`实际补货日期${i + 1}`} type="date" value={l.receivedDate} onChange={e => changeLine(kind,i,'receivedDate',e.target.value)} /></Field><Field label="补货备注"><textarea className={input} maxLength={2000} value={l.notes} onChange={e => changeLine(kind,i,'notes',e.target.value)} /></Field></>}
    <div className="flex flex-wrap gap-2"><button type="button" className={btn} onClick={() => setSelectionTarget(t => ({ ...t, [kind]: l.rowId }))}>{l.itemId ? '重选货品（保留已填内容）' : '选择此行货品'}</button><button type="button" className={btn} onClick={() => { update(kind,edit.content[kind].filter((_,n) => n !== i)); if (selectionTarget[kind] === l.rowId) setSelectionTarget(t => ({ ...t, [kind]: null })); }}>移除此项</button></div>
  </fieldset>)}</div>;
  return <section className="min-w-0 space-y-4">
    {error && <p role="alert" className="break-words rounded-xl bg-rose-50 p-3 text-rose-700">{error}</p>}{notice && <p role="status" className="rounded-xl bg-budu-50 p-3 text-sm">{notice}</p>}
    {edit ? <form onSubmit={e => { e.preventDefault(); save(); }} className="min-w-0 space-y-4 rounded-2xl bg-white p-4"><h3 className="text-lg font-bold">{edit.id ? '补充退货记录' : '新建退货记录'}</h3><p className="text-sm text-slate-500">只登记实际发生的退货、补货；可先保存未填完的内容。</p><fieldset disabled={busy} className="min-w-0 space-y-4">
      <Field label="退货来源门店"><select className={input} value={edit.content.storeKey} onChange={e => update('storeKey',e.target.value)}><option value="">选择来源门店</option>{stores.map(s => <option key={s.key} value={s.key}>{s.name}{s.active === false ? '（已停用，可登记历史退货）' : ''}</option>)}</select></Field>
      <Field label="供应商"><select className={input} value={edit.content.supplierId} onChange={e => update('supplierId',e.target.value)}><option value="">选择供应商</option>{options.suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
      {(edit.content.items.length > 0 || edit.content.replacements.length > 0) && <p className="text-xs text-slate-500">更换供应商只更新可选货品，已填明细会保留；不再需要的明细可逐项移除。</p>}
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
