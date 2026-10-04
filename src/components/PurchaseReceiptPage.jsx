import { useEffect, useRef, useState } from 'react';
import { api } from '../utils/api';
import { canManageProcurement, isProcurementDeveloper } from '../../shared/accountPermissions';
import { exportPurchaseImage } from '../utils/purchaseReceiptExport';
import { takeNotificationRecordFocus } from '../utils/notificationNavigation';
const labels = {
  DRAFT: '准备中',
  ORDERED: '待收货',
  RECEIVING: '收货处理中',
  CLOSED: '已结束',
  CANCELLED: '已取消',
  PENDING: '待核准',
  APPROVED: '已核准',
  RETURNED: '已退回'
};
const requestKey = () => crypto.randomUUID();
const btn = 'min-h-11 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 disabled:opacity-50';
const primary = btn + ' !bg-budu-500 !text-white !border-budu-500';
const input = 'w-full min-h-11 min-w-0 rounded-xl border border-slate-200 bg-white p-3 text-sm';
function Sheet({
  title,
  onClose,
  children,
  error
}) {
  useEffect(() => {
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = before;
    };
  }, []);
  return <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 sm:items-center" role="dialog" aria-label={title}><div className="max-h-[90dvh] w-full max-w-2xl overflow-y-auto rounded-t-3xl bg-white p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:rounded-3xl"><div className="mb-4 flex justify-between gap-4"><h3 className="text-lg font-bold">{title}</h3><button className={btn} onClick={onClose}>关闭</button></div>{error && <p role="alert" className="mb-3 rounded-xl bg-rose-50 p-3 text-rose-700">{error}</p>}{children}</div></div>;
}
export default function PurchaseReceiptPage({
  currentUser,
  onBack = () => {}
}) {
  const manage = canManageProcurement(currentUser),
    dev = isProcurementDeveloper(currentUser);
  const [orders, setOrders] = useState([]),
    [stores, setStores] = useState([]),
    [suppliers, setSuppliers] = useState([]),
    [products, setProducts] = useState([]),
    [tab, setTab] = useState('orders'),
    [storeFilter, setStoreFilter] = useState(''),
    [statusFilter, setStatusFilter] = useState('');
  const [detail, setDetail] = useState(null),
    [history, setHistory] = useState([]),
    [draft, setDraft] = useState(null),
    [supplier, setSupplier] = useState(null),
    [receipt, setReceipt] = useState(null),
    [action, setAction] = useState(null),
    [reason, setReason] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [preview, setPreview] = useState('');
  const saveKey = useRef(''),
    receiptKey = useRef(''),
    supplierKey = useRef('');
  const load = async () => {
    const [o, s] = await Promise.all([api('/v2/procurement/orders'), api('/v2/procurement/stores')]);
    setOrders(o.rows);
    setStores(s.rows);
    if (manage) {
      const [sp, p] = await Promise.all([api('/v2/procurement/suppliers'), api('/v2/procurement/items')]);
      setSuppliers(sp.rows);
      setProducts(p.rows);
    }
  };
  const openDetail = async id => {
    const d = await api('/v2/procurement/orders/' + id);
    setDetail(d.order);
    setHistory(d.history);
  };
  const run = async fn => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const focus = async id => {
    const d = await api('/v2/procurement/receipts/' + id);
    await openDetail(d.order.id);
  };
  useEffect(() => {
    run(async () => {
      await load();
      const id = takeNotificationRecordFocus('inventory-purchase');
      if (id) await focus(id);
    });
    const handler = e => {
      if (e.detail?.target === 'inventory-purchase') run(() => focus(e.detail.refId));
    };
    window.addEventListener('budu:notification-record-focus', handler);
    return () => window.removeEventListener('budu:notification-record-focus', handler);
  }, [currentUser.id]);
  const editDraft = o => {
    saveKey.current = requestKey();
    setDraft({
      ...o,
      content: structuredClone(o?.draftContent || {
        supplierId: '',
        storeKey: '',
        items: []
      })
    });
    setError('');
  };
  const refresh = async id => {
    await load();
    if (id) await openDetail(id);
  };
  const saveDraft = () => run(async () => {
    const path = '/v2/procurement/orders' + (draft.id ? '/' + draft.id : '');
    const d = await api(path, {
      method: draft.id ? 'PUT' : 'POST',
      body: JSON.stringify({
        requestKey: saveKey.current,
        version: draft.version,
        content: draft.content
      })
    });
    setDraft(null);
    await refresh(d.order.id);
    setNotice('采购清单已保存；实际微信下单后再标记');
  });
  const addItem = itemId => {
    if (!itemId || draft.content.items.some(x => x.itemId === itemId)) return;
    setDraft(d => ({
      ...d,
      content: {
        ...d.content,
        items: [...d.content.items, {
          itemId,
          quantity: '',
          unit: ''
        }]
      }
    }));
  };
  const changeItem = (index, field, value) => setDraft(d => ({
    ...d,
    content: {
      ...d.content,
      items: d.content.items.map((x, i) => i === index ? {
        ...x,
        [field]: value
      } : x)
    }
  }));
  const orderAction = (name, why = '') => run(async () => {
    const d = await api('/v2/procurement/orders/' + detail.id + '/' + name, {
      method: 'POST',
      body: JSON.stringify({
        requestKey: requestKey(),
        version: detail.version,
        ...(why ? {
          reason: why
        } : {})
      })
    });
    setAction(null);
    setReason('');
    await refresh(d.order.id);
  });
  const receiptAction = (r, name, why = '') => run(async () => {
    await api('/v2/procurement/receipts/' + r.id + '/' + name, {
      method: 'POST',
      body: JSON.stringify({
        requestKey: requestKey(),
        version: r.version,
        ...(why ? {
          reason: why
        } : {})
      })
    });
    setAction(null);
    setReason('');
    await refresh(detail.id);
  });
  const startReceipt = r => {
    receiptKey.current = requestKey();
    setReceipt(r ? {
      ...r,
      receivedDate: r.receivedDate.slice(0, 10),
      items: r.lines.map(x => ({
        orderLineId: x.orderLineId,
        quantity: x.receivedQty
      }))
    } : {
      receivedDate: new Date().toLocaleDateString('en-CA'),
      items: []
    });
  };
  const received = (lineId, value) => setReceipt(r => ({
    ...r,
    items: value ? r.items.some(x => x.orderLineId === lineId) ? r.items.map(x => x.orderLineId === lineId ? {
      ...x,
      quantity: value
    } : x) : [...r.items, {
      orderLineId: lineId,
      quantity: value
    }] : r.items.filter(x => x.orderLineId !== lineId)
  }));
  const submitReceipt = () => run(async () => {
    const d = await api(receipt.id ? '/v2/procurement/receipts/' + receipt.id + '/resubmit' : '/v2/procurement/orders/' + detail.id + '/receipts', {
      method: 'POST',
      body: JSON.stringify({
        requestKey: receiptKey.current,
        version: receipt.version,
        receivedDate: receipt.receivedDate,
        items: receipt.items
      })
    });
    setReceipt(null);
    await refresh(detail.id);
    const failed = d.notificationStatus?.some(x => x.status !== 'SENT');
    setNotice(failed ? '收货已提交，站内记录已保留；外部通知状态请查看本次记录' : '收货已提交，等待开发者核准');
  });
  const editSupplier = s => {
    supplierKey.current = requestKey();
    setSupplier(s ? {
      ...s,
      productIds: s.products.map(x => x.id)
    } : {
      name: '',
      productIds: []
    });
  };
  const saveSupplier = () => run(async () => {
    await api('/v2/procurement/suppliers' + (supplier.id ? '/' + supplier.id : ''), {
      method: supplier.id ? 'PUT' : 'POST',
      body: JSON.stringify({
        ...supplier,
        requestKey: supplierKey.current
      })
    });
    setSupplier(null);
    await load();
    setNotice('采购供应商与商品绑定已保存');
  });
  const exportImage = () => run(async () => {
    const data = await api('/v2/procurement/orders/' + detail.id + '/export-data');
    const image = await exportPurchaseImage(data, 'budu采购清单_' + detail.id + '_v' + data.revision + '.png');
    setPreview(image.dataUrl);
    setNotice('图片仍是本版本原要货清单；请自行微信分享');
  });
  const list = orders.filter(o => (!storeFilter || o.storeKey === storeFilter) && (!statusFilter || o.status === statusFilter));
  const lineName = id => detail?.lines.find(x => x.id === id)?.productNameSnapshot || '商品';
  return <main className="mx-auto max-w-5xl space-y-4 p-3 text-slate-800 sm:p-5">
 <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-xl font-black">采购入库</h2><button className={btn} onClick={onBack}>返回</button></div>
 {error && <p role="alert" className="break-words rounded-xl bg-rose-50 p-3 text-rose-700">{error}</p>}{notice && <p role="status" className="rounded-xl bg-budu-50 p-3 text-sm">{notice}</p>}
 <div className="flex flex-wrap gap-2"><button className={btn} onClick={() => {
        setTab('orders');
        setDetail(null);
      }}>采购单</button>{manage && <button className={btn} onClick={() => {
        setTab('suppliers');
        setDetail(null);
      }}>采购供应商</button>}</div>
 {tab === 'suppliers' && <section className="space-y-3"><button className={primary} onClick={() => editSupplier()}>新建采购供应商</button>{suppliers.map(s => <article key={s.id} className="rounded-2xl border bg-white p-4"><p className="break-words font-bold">{s.name}</p><p className="mt-2 text-sm">{s.products.map(x => x.name).join('、') || '尚未绑定商品'}</p><button className={btn + ' mt-3'} onClick={() => editSupplier(s)}>维护供应商</button></article>)}</section>}
 {tab === 'orders' && !detail && <><div className="flex flex-wrap gap-2">{manage && <button className={primary} onClick={() => editDraft()}>新建备单</button>}<select aria-label="筛选门店" className={input + ' !w-auto'} value={storeFilter} onChange={e => setStoreFilter(e.target.value)}><option value="">授权门店</option>{stores.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}</select><select aria-label="筛选状态" className={input + ' !w-auto'} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}><option value="">全部状态</option>{Object.entries(labels).slice(0, 5).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>{list.map(o => <button key={o.id} onClick={() => run(() => openDetail(o.id))} className="block w-full rounded-2xl border border-slate-100 bg-white p-4 text-left"><p className="break-words font-bold">{o.supplierNameSnapshot || '未选供应商'}</p><p className="mt-2 text-sm">{o.storeNameSnapshot || '未选门店'} · {labels[o.status]}</p></button>)}</>}
 {detail && tab === 'orders' && <section className="space-y-4">
 <button className={btn} onClick={() => setDetail(null)}>返回采购单列表</button><article className="rounded-2xl border bg-white p-4"><p className="break-words text-lg font-bold">{detail.supplierNameSnapshot || '未选供应商'}</p><p className="mt-2">{detail.storeNameSnapshot || '未选门店'} · <span data-testid="order-state">{labels[detail.status]}</span></p><h3 className="mt-4 font-bold">原要货清单</h3>{(detail.status === 'DRAFT' ? detail.draftContent.items || [] : detail.lines).map((l, i) => <div key={l.id || i} className="mt-3 rounded-xl bg-slate-50 p-3"><p className="break-words font-semibold">{l.productNameSnapshot}</p><p className="mt-1">要货 {l.orderedQty || l.quantity || '未填'} {l.unitSnapshot || l.unit}</p>{l.id && <p className="mt-1 text-sm" data-testid="approved-total">累计已核准 {detail.approved.find(x => x.orderLineId === l.id)?.quantity || '0'} {l.unitSnapshot} · 待核准 {detail.pending.find(x => x.orderLineId === l.id)?.quantity || '0'} {l.unitSnapshot}</p>}</div>)}<div className="mt-4 flex flex-wrap gap-2">{manage && <button className={btn} disabled={busy} onClick={exportImage}>导出采购图片</button>}{manage && !detail.receipts.length && ['DRAFT', 'ORDERED'].includes(detail.status) && <><button className={btn} onClick={() => editDraft(detail)}>修改要货清单</button><button className={btn} disabled={busy} onClick={() => orderAction('cancel')}>取消采购单</button></>}{manage && detail.status === 'DRAFT' && <button className={primary} disabled={busy} onClick={() => orderAction('mark-ordered')}>标记已下单</button>}{['ORDERED', 'RECEIVING'].includes(detail.status) && <button className={primary} disabled={busy} onClick={() => startReceipt()}>登记收货</button>}{dev && ['ORDERED', 'RECEIVING'].includes(detail.status) && <button className={btn} disabled={busy} onClick={() => orderAction('close')}>手动结束收货</button>}{dev && detail.status === 'CLOSED' && <button className={primary} onClick={() => {
            setReason('');
            setAction({
              name: 'reopen',
              title: '说明原因重开收货'
            });
          }}>重开收货</button>}</div></article>
 {detail.receipts.map(r => <article key={r.id} data-testid="receipt-card" className="rounded-2xl border bg-white p-4"><h3 className="font-bold">第{r.sequence}次收货 · {labels[r.status]}</h3><p className="mt-2 text-sm">实际收货 {r.receivedDate.slice(0, 10)} · 提交人 {r.submittedByName}</p>{r.lines.map(l => <p key={l.id} className="mt-2 break-words">{lineName(l.orderLineId)}　本次 {l.receivedQty} {detail.lines.find(x => x.id === l.orderLineId)?.unitSnapshot}</p>)}{r.events.map(e => <p key={e.id} className="mt-2 text-xs text-slate-500">通知：{{
            SENT: '已投递',
            FAILED: '投递失败，收货已提交',
            UNKNOWN: '投递结果不确定，收货已提交',
            PENDING: '等待投递',
            SENDING: '投递处理中'
          }[e.status] || e.status}{dev && e.status === 'FAILED' && <button className={btn + ' ml-2'} disabled={busy} onClick={() => run(async () => {
            await api('/v2/procurement/receipts/' + r.id + '/notification-retry', {
              method: 'POST',
              body: JSON.stringify({
                eventId: e.id
              })
            });
            await refresh(detail.id);
          })}>重试通知</button>}</p>)}<div className="mt-3 flex flex-wrap gap-2">{['ORDERED', 'RECEIVING'].includes(detail.status) && <>{r.status === 'RETURNED' && <button className={primary} onClick={() => startReceipt(r)}>修改本次并重新提交</button>}{dev && r.status === 'PENDING' && <><button className={primary} disabled={busy} onClick={() => receiptAction(r, 'approve')}>核准本次</button><button className={btn} onClick={() => {
                setReason('');
                setAction({
                  r,
                  name: 'return',
                  title: '填写原因退回本次'
                });
              }}>退回本次</button></>}{dev && r.status === 'APPROVED' && <button className={btn} onClick={() => {
              setReason('');
              setAction({
                r,
                name: 'withdraw',
                title: '填写原因撤回核准'
              });
            }}>撤回本次核准</button>}</>}</div></article>)}
 <details className="rounded-2xl border bg-white p-4"><summary className="cursor-pointer font-bold">操作与修改历史</summary>{history.map(a => <article key={a.id} className="mt-3 border-t pt-3 text-sm"><p>{{
              CREATE: '建立备单',
              EDIT: '修改要货清单',
              MARK_ORDERED: '标记已下单',
              SUBMIT: '提交收货',
              RESUBMIT: '修改后重新提交',
              APPROVE: '核准本次',
              RETURN: '退回本次',
              WITHDRAW: '撤回核准',
              CLOSE: '手动结束',
              REOPEN: '重开收货',
              CANCEL: '取消采购单'
            }[a.action] || '资料维护'} · {a.actorName} · {new Date(a.createdAt).toLocaleString()}</p>{a.reason && <p className="mt-1 break-words">原因：{a.reason}</p>}{a.before?.lines && <p className="mt-1 break-words">修改前：{a.before.lines.map(l => l.receivedQty || l.orderedQty).join('、')}</p>}{a.after?.lines && <p className="mt-1 break-words">修改后：{a.after.lines.map(l => l.receivedQty || l.orderedQty).join('、')}</p>}</article>)}</details>
 </section>}
 {draft && <Sheet error={error} title="采购备单" onClose={() => setDraft(null)}><div className="space-y-4"><label className="block">采购供应商<select className={input} aria-label="采购供应商" value={draft.content.supplierId || ''} onChange={e => setDraft(d => ({
            ...d,
            content: {
              ...d.content,
              supplierId: e.target.value,
              items: []
            }
          }))}><option value="">请选择</option>{suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label><label className="block">收货门店<select className={input} aria-label="收货门店" value={draft.content.storeKey || ''} onChange={e => setDraft(d => ({
            ...d,
            content: {
              ...d.content,
              storeKey: e.target.value
            }
          }))}><option value="">请选择</option>{stores.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}</select></label><select className={input} aria-label="添加采购商品" value="" onChange={e => addItem(e.target.value)}><option value="">添加该供应商商品</option>{products.filter(p => p.purchaseEnabled && p.procurementSupplierId === draft.content.supplierId && !draft.content.items.some(x => x.itemId === p.id)).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>{draft.content.items.map((l, i) => <div key={l.itemId} className="rounded-xl bg-slate-50 p-3"><p className="break-words">{products.find(p => p.id === l.itemId)?.name || l.productNameSnapshot}</p><div className="mt-2 grid grid-cols-2 gap-2"><input aria-label={'要货数量' + (i + 1)} className={input} inputMode="decimal" value={l.quantity} onChange={e => changeItem(i, 'quantity', e.target.value)} placeholder="数量" /><input aria-label={'要货单位' + (i + 1)} className={input} value={l.unit} onChange={e => changeItem(i, 'unit', e.target.value)} placeholder="单位" /></div><button className={btn + ' mt-2'} onClick={() => setDraft(d => ({
            ...d,
            content: {
              ...d.content,
              items: d.content.items.filter((_, j) => j !== i)
            }
          }))}>移除此行</button></div>)}<button className={primary + ' w-full'} disabled={busy} onClick={saveDraft}>保存备单</button></div></Sheet>}
 {supplier && <Sheet error={error} title="采购供应商维护" onClose={() => setSupplier(null)}><input aria-label="供应商名称" className={input} value={supplier.name} onChange={e => setSupplier(s => ({
        ...s,
        name: e.target.value
      }))} /><h4 className="mt-4 font-bold">绑定采购商品</h4><div className="mt-3 space-y-2">{products.filter(p => p.purchaseEnabled).map(p => <label key={p.id} className="flex items-start gap-3 rounded-xl border p-3 text-sm"><input className="mt-1" type="checkbox" aria-label={'绑定' + p.name} disabled={!!p.procurementSupplierId && p.procurementSupplierId !== supplier.id} checked={supplier.productIds.includes(p.id)} onChange={e => setSupplier(s => ({
            ...s,
            productIds: e.target.checked ? [...s.productIds, p.id] : s.productIds.filter(id => id !== p.id)
          }))} /><span className="break-words">{p.name}{p.procurementSupplierId && p.procurementSupplierId !== supplier.id ? '（已有其他供应商）' : ''}</span></label>)}</div><button className={primary + ' mt-4 w-full'} disabled={busy} onClick={saveSupplier}>保存采购供应商</button></Sheet>}
 {receipt && <Sheet error={error} title="登记收货" onClose={() => {
      if (window.confirm('关闭后未提交的输入将丢失，是否关闭？')) setReceipt(null);
    }}><label className="block">实际收货日期<input type="date" aria-label="实际收货日期" className={input} value={receipt.receivedDate} onChange={e => setReceipt(r => ({
          ...r,
          receivedDate: e.target.value
        }))} /></label><p className="my-3 text-sm text-slate-500">只填写本次实际到货；未到商品留空。单位沿用原清单。</p>{detail.lines.map((l, i) => <label key={l.id} className="mb-3 block rounded-xl bg-slate-50 p-3"><span className="block break-words">{l.productNameSnapshot} · {l.unitSnapshot}</span><input aria-label={'本次实收' + (i + 1)} className={input + ' mt-2'} inputMode="decimal" value={receipt.items.find(x => x.orderLineId === l.id)?.quantity || ''} onChange={e => received(l.id, e.target.value)} /></label>)}<button className={primary + ' w-full'} disabled={busy} onClick={submitReceipt}>提交本次收货</button></Sheet>}
 {action && <Sheet error={error} title={action.title} onClose={() => setAction(null)}><textarea aria-label="操作原因" className={input} value={reason} onChange={e => setReason(e.target.value)} placeholder="填写原因" /><button className={primary + ' mt-3 w-full'} disabled={busy || !reason.trim()} onClick={() => action.r ? receiptAction(action.r, action.name, reason) : orderAction(action.name, reason)}>确认操作</button></Sheet>}
 {preview && <Sheet error={error} title="采购图片预览" onClose={() => setPreview('')}><p className="mb-3 text-sm">可长按保存图片，再自行微信分享。</p><img data-testid="purchase-image-preview" alt="采购清单图片" src={preview} className="h-auto w-full" /></Sheet>}
 </main>;
}
