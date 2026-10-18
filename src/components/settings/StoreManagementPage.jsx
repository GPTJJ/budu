import { useEffect, useRef, useState } from 'react'
import { Check, LoaderCircle, Pencil, Plus, RefreshCw, Store, X } from 'lucide-react'
import { api } from '../../utils/api'
import { getStores, getUserData, onUserDataUpdated, refreshStoreDirectory } from '../../utils/userData'
import { broadcastStoreDirectoryChanged, newStoreRequestKey } from '../../utils/storeDirectory'
import { SettingsDetailPage, SettingsStatus } from './SettingsPrimitives'

const actionClass = 'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl px-3 text-sm font-semibold disabled:opacity-40'

export default function StoreManagementPage({ user, onBack }) {
  const [stores, setStores] = useState(getStores)
  const [verified, setVerified] = useState(() => getUserData().storesAuthority === 'postgresql')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [editor, setEditor] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [statusRetries, setStatusRetries] = useState({})
  const [createUncertain, setCreateUncertain] = useState(false)
  const submittedCreate = useRef(null)
  const mutationBusy = useRef(false)
  const mounted = useRef(true)
  const canManage = user?.role === 'developer'
  const editingStore = editor?.key ? stores.find((store) => store.key === editor.key) : null
  const pickupVerified = !editor?.key || (!loading && verified && typeof editingStore?.pickupEnabled === 'boolean')
  const editorPickupEnabled = editor?.pickupEnabled ?? (pickupVerified ? editingStore?.pickupEnabled : undefined)

  useEffect(() => {
    mounted.current = true
    const sync = () => {
      if (!mounted.current) return
      const rows = getStores()
      const valid = getUserData().storesAuthority === 'postgresql'
      setStores(rows)
      setVerified(valid)
      if (valid) setStatusRetries((current) => Object.fromEntries(Object.entries(current)
        .filter(([key, target]) => rows.find((row) => row.key === key)?.active !== target)))
    }
    const unsubscribe = onUserDataUpdated(sync)
    refreshStoreDirectory().catch((nextError) => {
      if (mounted.current) setError(nextError.message)
    }).finally(() => {
      if (mounted.current) { sync(); setLoading(false) }
    })
    return () => { mounted.current = false; unsubscribe() }
  }, [user?.id])

  const refresh = async () => {
    if (mutationBusy.current) return
    setLoading(true)
    setError('')
    try { await refreshStoreDirectory() }
    catch (nextError) { if (mounted.current) setError(nextError.message) }
    finally { if (mounted.current) setLoading(false) }
  }

  const beginEditor = (store = null) => {
    if (mutationBusy.current) return
    submittedCreate.current = null
    setCreateUncertain(false)
    setError('')
    setNotice('')
    setEditor(store
      // An untouched pickup option follows the verified directory, never a cached default.
      ? { key: store.key, name: store.name, district: store.district || '', pickupEnabled: null }
      : { name: '', district: '', active: true, pickupEnabled: true, requestKey: newStoreRequestKey() })
  }

  const refreshAfterWrite = async () => {
    // Invalidate other tabs even when this tab cannot confirm its follow-up read.
    broadcastStoreDirectoryChanged()
    try { await refreshStoreDirectory(); return true }
    catch { return false }
  }

  const save = async (event) => {
    event.preventDefault()
    if (!canManage || mutationBusy.current || !editor) return
    if (!editor.name.trim()) return setError('请填写门店名称')
    const creating = !editor.key
    if (!creating && (loading || getUserData().storesAuthority !== 'postgresql'
      || typeof getStores().find((store) => store.key === editor.key)?.pickupEnabled !== 'boolean')) {
      return setError('自提设置尚未核实，请刷新门店列表后保存。')
    }
    mutationBusy.current = true
    setBusy('editor')
    setError('')
    setNotice('')
    const payload = creating
      ? submittedCreate.current || { name: editor.name.trim(), district: editor.district.trim(), active: editor.active, pickupEnabled: editor.pickupEnabled, requestKey: editor.requestKey }
      : { name: editor.name.trim(), district: editor.district.trim(),
        ...(typeof editor.pickupEnabled === 'boolean' ? { pickupEnabled: editor.pickupEnabled } : {}) }
    if (creating) submittedCreate.current = payload
    try {
      const result = await api(creating ? '/v2/stores' : `/v2/stores/${encodeURIComponent(editor.key)}`, {
        method: creating ? 'POST' : 'PATCH', body: JSON.stringify(payload),
      })
      if (result?.ok !== true || !result.store?.key) throw new Error('保存结果尚未确认，请重试保存')
      const synchronized = await refreshAfterWrite()
      if (!mounted.current) return
      submittedCreate.current = null
      setCreateUncertain(false)
      setEditor(null)
      setNotice(`${result.store.name || payload.name}${creating ? '已新增' : '已保存'}${synchronized ? '' : '；门店列表暂未同步，请刷新'}`)
    } catch (nextError) {
      if (!mounted.current) return
      const uncertain = creating && (!nextError.status || nextError.status >= 500 || [408, 429].includes(nextError.status))
      if (creating && !uncertain) submittedCreate.current = null
      setCreateUncertain(uncertain)
      setError(uncertain ? '尚未确认新增结果，请重试保存，系统会核对同一次新增。' : nextError.message)
    } finally {
      mutationBusy.current = false
      if (mounted.current) setBusy('')
    }
  }

  const setStatus = async (store, targetActive) => {
    if (!canManage || mutationBusy.current) return
    mutationBusy.current = true
    setBusy(store.key)
    setError('')
    setNotice('')
    try {
      // The captured target survives retry; never ask the server to "toggle".
      const result = await api(`/v2/stores/${encodeURIComponent(store.key)}/status`, {
        method: 'PUT', body: JSON.stringify({ active: targetActive }),
      })
      if (result?.ok !== true || result.store?.active !== targetActive) throw new Error('门店状态尚未确认')
      const synchronized = await refreshAfterWrite()
      if (!mounted.current) return
      setStatusRetries((current) => { const next = { ...current }; delete next[store.key]; return next })
      setNotice(`${result.store.name || store.name}已${targetActive ? '启用' : '停用'}${synchronized ? '' : '；门店列表暂未同步，请刷新'}`)
    } catch (nextError) {
      broadcastStoreDirectoryChanged()
      let rows = null
      try { rows = await refreshStoreDirectory() } catch { /* Keep the captured target for an explicit retry. */ }
      if (!mounted.current) return
      if (getUserData().storesAuthority === 'postgresql' && rows?.some((row) => row.key === store.key && row.active === targetActive)) {
        setStatusRetries((current) => { const next = { ...current }; delete next[store.key]; return next })
        setNotice(`${store.name}已${targetActive ? '启用' : '停用'}`)
      } else {
        setStatusRetries((current) => ({ ...current, [store.key]: targetActive }))
        setError(nextError.message || '门店状态更新失败，请重试')
      }
    } finally {
      mutationBusy.current = false
      if (mounted.current) setBusy('')
    }
  }

  if (!canManage) return null
  return (
    <SettingsDetailPage title="门店管理" subtitle="新增门店、编辑资料与启停" onBack={onBack} actions={
      <button type="button" aria-label="刷新门店列表" disabled={loading || Boolean(busy)} onClick={refresh} className="grid h-11 w-11 place-items-center rounded-full text-slate-500 hover:bg-slate-100 disabled:opacity-40"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></button>
    }>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-500">{loading && !stores.length ? '正在读取门店…' : `共 ${stores.length} 家门店`}</p>
        <button type="button" disabled={Boolean(busy)} onClick={() => beginEditor()} className={`${actionClass} bg-budu-600 text-white`}><Plus className="h-4 w-4" />新增门店</button>
      </div>
      <p className="rounded-2xl bg-budu-50/50 px-4 py-3 text-xs leading-5 text-slate-500">停用后停止新业务，历史记录和已有单据保留。需要恢复时，重新打开开关即可。</p>
      {error && <p role="alert" className="rounded-xl bg-rose-50 px-4 py-3 text-sm leading-5 text-rose-700">{error}</p>}
      {notice && <p role="status" className="flex items-start gap-2 rounded-xl bg-emerald-50 px-4 py-3 text-sm leading-5 text-emerald-700"><Check className="mt-0.5 h-4 w-4 shrink-0" />{notice}</p>}
      {!verified && !loading && <p role="status" className="text-xs leading-5 text-amber-700">当前门店状态尚未核实，请刷新后操作启停。</p>}
      {editor && <form aria-label={editor.key ? '编辑门店' : '新增门店'} onSubmit={save} className="min-w-0 space-y-4 rounded-[18px] border border-budu-100 bg-budu-50/30 p-4 sm:p-5">
        <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-bold text-slate-800">{editor.key ? '编辑门店资料' : '新增门店'}</h3><button type="button" aria-label="取消编辑门店" disabled={Boolean(busy)} onClick={() => setEditor(null)} className="grid h-11 w-11 place-items-center rounded-full text-slate-500 hover:bg-white disabled:opacity-40"><X className="h-4 w-4" /></button></div>
        <label className="block text-xs font-semibold text-slate-500">门店名称<input aria-label="门店名称" required maxLength={30} disabled={Boolean(busy) || createUncertain} value={editor.name} onChange={(event) => setEditor((current) => ({ ...current, name: event.target.value }))} className="input mt-1.5 min-h-11 w-full" placeholder="例如：北京官舍店" /></label>
        <label className="block text-xs font-semibold text-slate-500">位置说明（选填）<input aria-label="位置说明（选填）" maxLength={50} disabled={Boolean(busy) || createUncertain} value={editor.district} onChange={(event) => setEditor((current) => ({ ...current, district: event.target.value }))} className="input mt-1.5 min-h-11 w-full" placeholder="例如：朝阳区 · 亮马桥" /></label>
        <div>
          <label className="flex min-h-11 items-center gap-3 text-sm font-medium text-slate-700"><input type="checkbox" aria-describedby="store-pickup-description" checked={editorPickupEnabled === true} disabled={Boolean(busy) || createUncertain || !pickupVerified} onChange={(event) => setEditor((current) => ({ ...current, pickupEnabled: event.target.checked }))} className="h-5 w-5 shrink-0 accent-budu-600" />支持顾客自提</label>
          <p id="store-pickup-description" className="ml-8 text-xs leading-5 text-slate-500">关闭后不可选择此处自提，收货和调拨照常使用。</p>
          {!pickupVerified && <p role="status" className="mt-2 text-xs leading-5 text-amber-700">自提设置尚未核实，请刷新门店列表后编辑。</p>}
        </div>
        {!editor.key && <label className="flex min-h-11 items-center gap-3 text-sm font-medium text-slate-700"><input type="checkbox" checked={editor.active} disabled={Boolean(busy) || createUncertain} onChange={(event) => setEditor((current) => ({ ...current, active: event.target.checked }))} className="h-5 w-5 accent-budu-600" />创建后启用</label>}
        <div className="flex flex-wrap gap-2"><button type="submit" disabled={Boolean(busy) || !pickupVerified} className={`${actionClass} flex-1 bg-budu-600 text-white sm:flex-none sm:px-5`}>{busy === 'editor' ? <><LoaderCircle className="h-4 w-4 animate-spin" />保存中…</> : createUncertain ? '重试保存' : '保存门店'}</button><button type="button" disabled={Boolean(busy)} onClick={() => setEditor(null)} className={`${actionClass} bg-white text-slate-500 ring-1 ring-slate-200`}>取消</button></div>
      </form>}
      <div className="space-y-3" aria-label="门店列表">
        {stores.map((store) => {
          const retry = statusRetries[store.key]
          const changing = busy === store.key
          return <article key={store.key} data-testid={`managed-store-${store.key}`} className="min-w-0 rounded-[18px] border border-slate-200/75 bg-white p-4">
            <div className="flex min-w-0 items-start gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-budu-50 text-budu-600"><Store className="h-5 w-5" /></span><div className="min-w-0 flex-1"><h3 className="break-words text-sm font-bold leading-6 text-slate-800">{store.name}</h3>{store.district && <p className="mt-0.5 break-words text-xs leading-5 text-slate-400">{store.district}</p>}<p className="mt-1 text-xs leading-5 text-slate-500">{verified && typeof store.pickupEnabled === 'boolean' ? store.pickupEnabled ? '支持顾客自提' : '不支持顾客自提' : '自提设置待核实'}</p></div></div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3">
              <div className="flex items-center gap-2"><SettingsStatus tone={!verified ? 'warning' : store.active ? 'success' : 'neutral'}>{!verified ? '待核实' : store.active ? '已启用' : '已停用'}</SettingsStatus><button type="button" role="switch" aria-label={`${store.name}营业状态`} aria-checked={store.active === true} aria-busy={changing} disabled={!verified || Boolean(busy) || retry !== undefined} onClick={() => void setStatus(store, !store.active)} className={`relative inline-flex h-11 w-14 shrink-0 items-center rounded-full p-1.5 transition disabled:opacity-50 ${store.active ? 'bg-budu-600' : 'bg-slate-200'}`}><span className={`grid h-8 w-8 place-items-center rounded-full bg-white shadow-sm transition-transform ${store.active ? 'translate-x-3' : ''}`}>{changing && <LoaderCircle className="h-4 w-4 animate-spin text-budu-600" />}</span></button></div>
              <button type="button" aria-label={`编辑${store.name}`} disabled={Boolean(busy)} onClick={() => beginEditor(store)} className={`${actionClass} text-slate-500 hover:bg-slate-50`}><Pencil className="h-3.5 w-3.5" />编辑</button>
            </div>
            {retry !== undefined && <button type="button" disabled={Boolean(busy)} onClick={() => void setStatus(store, retry)} className={`${actionClass} mt-2 w-full bg-amber-50 text-amber-800`}>重试{retry ? '启用' : '停用'}</button>}
          </article>
        })}
        {!loading && !stores.length && verified && <p className="py-8 text-center text-sm text-slate-400">还没有门店，点击上方新增。</p>}
      </div>
    </SettingsDetailPage>
  )
}
