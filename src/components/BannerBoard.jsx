import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, ImageIcon, Plus, Send, Trash2, X } from 'lucide-react'
import { api } from '../utils/api'
import { compressProductImage } from '../utils/pos'

/**
 * 首页轮播（营销）
 *
 * 数据流：OS Postgres 是编辑权威 → 「同步到小程序」把启用中的条目整包写入
 * CloudBase `home_banners/config` → 小程序首页读取后覆盖包内 HOME.banners。
 *
 * 注意：读取远程配置的代码属于小程序 1.0.36 起的能力。更早的线上版本会继续用
 * 包内默认轮播，所以这里必须把「发布 ≠ 立即对所有人生效」写在页面上，避免误判。
 */

const LINK_TYPES = [
  { value: 'product', label: '商品详情', hint: '小程序商品 ID，例如 c1' },
  { value: 'collection', label: '合集', hint: '合集 ID，例如 gift' },
  { value: 'shop', label: '商城首页', hint: '跳到「全部商品」页' },
  { value: 'page', label: '站内页面', hint: '以 /pages/ 开头的路径' },
  { value: 'none', label: '不跳转', hint: '点击后滚动到精选区' },
]

const LINK_LABEL = LINK_TYPES.reduce((out, item) => ({ ...out, [item.value]: item.label }), {})

const inputClass = 'w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-budu-400'

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-slate-600">{label}</span>
        {hint ? <span className="text-[11px] text-slate-400">{hint}</span> : null}
      </div>
      {children}
    </label>
  )
}

function fmtTime(value) {
  if (!value) return '尚未发布'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function emptyForm(nextSort) {
  return {
    id: '',
    image: '',
    imageDisplay: '',
    title: '',
    en: '',
    subtitle: '',
    dateText: '',
    ctaText: '查看详情',
    linkType: 'none',
    linkValue: '',
    sortOrder: nextSort,
    enabled: true,
  }
}

/** 轮播主图：手机上是 aspectFill 裁切，这里按同一比例预览 */
function BannerThumb({ src, className = '' }) {
  const [broken, setBroken] = useState(false)
  useEffect(() => { setBroken(false) }, [src])
  if (!src || broken) {
    return (
      <div className={`grid place-items-center bg-slate-100 text-slate-300 ${className}`}>
        <ImageIcon size={18} />
      </div>
    )
  }
  return <img src={src} alt="" className={className} onError={() => setBroken(true)} />
}

export default function BannerBoard() {
  const [rows, setRows] = useState([])
  const [publish, setPublish] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState(emptyForm(1))
  const [confirmId, setConfirmId] = useState('')
  const fileRef = useRef(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api('/v2/online-catalog/banners')
      setRows(res.banners || [])
      setPublish(res.publish || null)
    } catch (err) {
      setError(err.message || '加载轮播配置失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const enabledRows = useMemo(() => rows.filter((row) => row.enabled), [rows])
  const preview = enabledRows[0] || rows[0] || null

  const openCreate = () => {
    const nextSort = rows.reduce((max, row) => Math.max(max, row.sortOrder || 0), 0) + 1
    setForm(emptyForm(nextSort))
    setOpen(true)
    setError('')
    setNotice('')
  }

  const openEdit = (row) => {
    setForm({
      id: row.id,
      image: row.image || '',
      imageDisplay: row.imageDisplay || row.image || '',
      title: row.title || '',
      en: row.en || '',
      subtitle: row.subtitle || '',
      dateText: row.dateText || '',
      ctaText: row.ctaText || '',
      linkType: row.linkType || 'none',
      linkValue: row.linkValue || '',
      sortOrder: row.sortOrder ?? 0,
      enabled: row.enabled !== false,
    })
    setOpen(true)
    setError('')
    setNotice('')
  }

  const update = (patch) => setForm((current) => ({ ...current, ...patch }))

  const pickImage = async (file) => {
    if (!file) return
    setUploading(true)
    setError('')
    try {
      // 轮播是满屏主图，压缩上限比商品图更宽（1440px），仍远低于接口 1.5MB 限制
      const dataUrl = await compressProductImage(file, { maxSide: 1440, maxBytes: 1400000 })
      const res = await api('/v2/online-catalog/uploads', { method: 'POST', body: JSON.stringify({ data: dataUrl }) })
      update({ image: res.fileId, imageDisplay: res.url || dataUrl })
    } catch (err) {
      setError(err.message || '图片上传失败')
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const save = async () => {
    if (!form.image) { setError('请先上传轮播图片'); return }
    if (!form.title.trim()) { setError('请填写标题'); return }
    if (['product', 'collection', 'page'].includes(form.linkType) && !form.linkValue.trim()) {
      setError('请填写跳转目标')
      return
    }
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const payload = {
        image: form.image,
        title: form.title,
        en: form.en,
        subtitle: form.subtitle,
        dateText: form.dateText,
        ctaText: form.ctaText,
        linkType: form.linkType,
        linkValue: form.linkValue,
        sortOrder: form.sortOrder,
        enabled: form.enabled,
      }
      if (form.id) await api(`/v2/online-catalog/banners/${form.id}`, { method: 'PUT', body: JSON.stringify(payload) })
      else await api('/v2/online-catalog/banners', { method: 'POST', body: JSON.stringify(payload) })
      setOpen(false)
      setNotice('已保存。改动需要点「同步到小程序」才会生效。')
      await load()
    } catch (err) {
      setError(err.message || '保存失败')
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (row) => {
    setBusy(true)
    setError('')
    try {
      await api(`/v2/online-catalog/banners/${row.id}`, { method: 'PUT', body: JSON.stringify({ enabled: !row.enabled }) })
      await load()
    } catch (err) {
      setError(err.message || '切换失败')
    } finally {
      setBusy(false)
    }
  }

  const move = async (row, delta) => {
    const sorted = [...rows]
    const index = sorted.findIndex((item) => item.id === row.id)
    const target = index + delta
    if (index < 0 || target < 0 || target >= sorted.length) return
    const a = sorted[index]
    const b = sorted[target]
    setBusy(true)
    setError('')
    try {
      // 两条顺序互换：先给 a 占位值，再写 b，避免唯一性冲突（当前无唯一约束，仍保持原子感）
      await api(`/v2/online-catalog/banners/${a.id}`, { method: 'PUT', body: JSON.stringify({ sortOrder: b.sortOrder }) })
      await api(`/v2/online-catalog/banners/${b.id}`, { method: 'PUT', body: JSON.stringify({ sortOrder: a.sortOrder }) })
      await load()
    } catch (err) {
      setError(err.message || '调整顺序失败')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (row) => {
    setBusy(true)
    setError('')
    try {
      await api(`/v2/online-catalog/banners/${row.id}`, { method: 'DELETE' })
      setConfirmId('')
      setNotice('已删除。记得重新同步到小程序。')
      await load()
    } catch (err) {
      setError(err.message || '删除失败')
    } finally {
      setBusy(false)
    }
  }

  const importDefaults = async () => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const res = await api('/v2/online-catalog/banners/import-defaults', { method: 'POST', body: JSON.stringify({}) })
      setNotice(`已导入 ${res.imported} 条当前线上轮播，改完记得点「同步到小程序」。`)
      await load()
    } catch (err) {
      setError(err.message || '导入失败')
    } finally {
      setBusy(false)
    }
  }

  const publishAll = async () => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const res = await api('/v2/online-catalog/banners/publish', { method: 'POST', body: JSON.stringify({}) })
      setNotice(`已同步 ${res.published?.count ?? 0} 条轮播到小程序（版本 ${res.published?.version ?? '—'}）。客户端有 60 秒缓存，重启小程序即可看到。`)
      await load()
    } catch (err) {
      setError(err.message || '同步失败')
    } finally {
      setBusy(false)
    }
  }

  const status = (() => {
    if (!publish) return { label: '未知', cls: 'bg-slate-100 text-slate-500' }
    if (publish.state === 'FAILED') return { label: '上次同步失败', cls: 'bg-rose-50 text-rose-600' }
    if (!publish.publishedAt) return { label: '尚未发布', cls: 'bg-slate-100 text-slate-500' }
    if (publish.dirty) return { label: '有改动未同步', cls: 'bg-amber-50 text-amber-700' }
    return { label: '已同步', cls: 'bg-emerald-50 text-emerald-700' }
  })()

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
          <span className={`rounded-md px-2 py-0.5 ${status.cls}`}>{status.label}</span>
          <span>线上版本 {publish?.version || 0}</span>
          <span>·</span>
          <span>{fmtTime(publish?.publishedAt)}</span>
          <span>·</span>
          <span>{enabledRows.length} 条启用 / 共 {rows.length} 条</span>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={openCreate} disabled={busy || rows.length >= 10}
            className="inline-flex h-9 items-center gap-1 rounded-xl border border-slate-200 px-3 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50">
            <Plus size={15} /> 新增轮播
          </button>
          <button type="button" onClick={publishAll} disabled={busy || !enabledRows.length}
            className="inline-flex h-9 items-center gap-1 rounded-xl bg-budu-500 px-4 text-sm font-semibold text-white disabled:opacity-50">
            <Send size={15} /> 同步到小程序
          </button>
        </div>
      </div>

      <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-2 text-[11px] leading-relaxed text-amber-800">
        远程轮播由 <b>小程序 1.0.36 及以上</b>读取；更早的线上版本仍显示包内默认轮播，不会因为这里改了内容而出现空白。
        发布只影响启用中的条目，顺序按「排序值」从小到大。
      </div>

      {error ? <div className="mb-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-700">{error}</div> : null}
      {notice ? <div className="mb-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-xs text-emerald-700">{notice}</div> : null}
      {publish?.state === 'FAILED' && publish?.lastError ? (
        <div className="mb-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-700">
          上次同步失败：{publish.lastError}
        </div>
      ) : null}

      {loading ? (
        <div className="rounded-2xl border border-slate-200 bg-white px-4 py-10 text-center text-sm text-slate-400">加载中…</div>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-white px-4 py-12 text-center">
          <div className="text-sm text-slate-600">还没有轮播条目</div>
          <div className="mt-1 text-[11px] text-slate-400">「导入当前线上轮播」会把小程序包内那 7 条变成可编辑数据，不用重新录入</div>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <button type="button" onClick={importDefaults} disabled={busy}
              className="rounded-xl bg-budu-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">导入当前线上轮播</button>
            <button type="button" onClick={openCreate} disabled={busy}
              className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-600 disabled:opacity-50">从空开始新增</button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {[...rows].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0)).map((row, index, list) => (
            <div key={row.id} className={`flex flex-wrap items-center gap-3 rounded-2xl border bg-white p-3 ${row.enabled ? 'border-slate-200' : 'border-slate-200 opacity-60'}`}>
              <BannerThumb src={row.imageDisplay || row.image} className="h-16 w-[88px] shrink-0 rounded-lg object-cover" />

              <div className="min-w-[180px] flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-semibold text-slate-800">{row.title || '未命名'}</span>
                  <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">{LINK_LABEL[row.linkType] || row.linkType}</span>
                  {row.linkValue ? <span className="rounded-md bg-slate-50 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">{row.linkValue}</span> : null}
                  {row.enabled ? null : <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">已停用</span>}
                </div>
                <div className="mt-1 truncate text-[11px] text-slate-500">
                  {row.en ? <span className="mr-2 tracking-wide text-slate-400">{row.en}</span> : null}
                  {row.subtitle || '—'}
                </div>
              </div>

              <div className="flex items-center gap-1">
                <button type="button" title="上移" disabled={busy || index === 0} onClick={() => move(row, -1)}
                  className="grid h-8 w-8 place-items-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-30"><ArrowUp size={14} /></button>
                <button type="button" title="下移" disabled={busy || index === list.length - 1} onClick={() => move(row, 1)}
                  className="grid h-8 w-8 place-items-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-30"><ArrowDown size={14} /></button>
                <button type="button" onClick={() => toggle(row)} disabled={busy}
                  className={`h-8 rounded-lg border px-2.5 text-xs ${row.enabled ? 'border-slate-200 text-slate-600 hover:bg-slate-50' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}>
                  {row.enabled ? '停用' : '启用'}
                </button>
                <button type="button" onClick={() => openEdit(row)} disabled={busy}
                  className="h-8 rounded-lg border border-slate-200 px-2.5 text-xs text-slate-600 hover:bg-slate-50">编辑</button>
                {confirmId === row.id ? (
                  <span className="flex items-center gap-1">
                    <button type="button" onClick={() => remove(row)} disabled={busy}
                      className="h-8 rounded-lg bg-rose-500 px-2.5 text-xs font-medium text-white">确认删除</button>
                    <button type="button" onClick={() => setConfirmId('')}
                      className="grid h-8 w-8 place-items-center rounded-lg border border-slate-200 text-slate-400"><X size={14} /></button>
                  </span>
                ) : (
                  <button type="button" onClick={() => setConfirmId(row.id)} disabled={busy}
                    className="grid h-8 w-8 place-items-center rounded-lg border border-slate-200 text-slate-400 hover:text-rose-500"><Trash2 size={14} /></button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {preview ? (
        <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-4">
          <div className="mb-3 text-xs font-medium text-slate-600">首屏预览（第一条启用项，按手机比例裁切）</div>
          <div className="flex flex-wrap items-start gap-4">
            <div className="relative w-[228px] overflow-hidden rounded-2xl bg-slate-900" style={{ aspectRatio: '0.69' }}>
              <BannerThumb src={preview.imageDisplay || preview.image} className="h-full w-full object-cover" />
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-4 pb-5 pt-16 text-white">
                {preview.en ? <div className="text-[9px] tracking-[0.2em] text-white/70">{preview.en}</div> : null}
                <div className="mt-1 text-lg font-semibold leading-tight">{preview.title}</div>
                {preview.subtitle ? <div className="mt-1 text-[11px] text-white/80">{preview.subtitle}</div> : null}
                {preview.ctaText ? <div className="mt-2 inline-block rounded-full border border-white/60 px-3 py-1 text-[10px]">{preview.ctaText}</div> : null}
              </div>
            </div>
            <div className="max-w-[320px] text-[11px] leading-relaxed text-slate-500">
              <p>图片建议 <b>1080×1560</b>（宽高比约 0.69），单张 ≤300KB，主体居中。</p>
              <p className="mt-1">底部 1/3 会压渐变与文案，别把重要信息放那里。</p>
              <p className="mt-1">上传后由系统压缩到 1440px 长边，无需你自己先压。</p>
            </div>
          </div>
        </div>
      ) : null}

      {open ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4">
          <div className="mt-6 w-full max-w-3xl rounded-2xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
              <div className="text-sm font-semibold text-slate-800">{form.id ? '编辑轮播' : '新增轮播'}</div>
              <button type="button" onClick={() => setOpen(false)} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-50"><X size={16} /></button>
            </div>

            <div className="grid gap-4 px-5 py-4 md:grid-cols-[220px_1fr]">
              <div>
                <div className="mb-1 text-xs font-medium text-slate-600">轮播图</div>
                <div className="relative overflow-hidden rounded-xl border border-dashed border-slate-200 bg-slate-50" style={{ aspectRatio: '0.69' }}>
                  <BannerThumb src={form.imageDisplay || form.image} className="h-full w-full object-cover" />
                  {uploading ? <div className="absolute inset-0 grid place-items-center bg-white/70 text-xs text-slate-500">上传中…</div> : null}
                </div>
                <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(event) => pickImage(event.target.files && event.target.files[0])} />
                <button type="button" onClick={() => fileRef.current && fileRef.current.click()} disabled={uploading}
                  className="mt-2 w-full rounded-xl border border-slate-200 py-2 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50">
                  选择图片
                </button>
                <div className="mt-1 text-[10px] leading-relaxed text-slate-400">建议 1080×1560，主体居中，底部留空。</div>
              </div>

              <div className="grid gap-3">
                <div className="grid gap-3 md:grid-cols-2">
                  <Field label="标题" hint="最多 20 字">
                    <input className={inputClass} value={form.title} maxLength={20} onChange={(e) => update({ title: e.target.value })} />
                  </Field>
                  <Field label="英文标题" hint="最多 40 字">
                    <input className={inputClass} value={form.en} maxLength={40} onChange={(e) => update({ en: e.target.value })} />
                  </Field>
                </div>

                <Field label="副标题" hint="最多 40 字">
                  <input className={inputClass} value={form.subtitle} maxLength={40} onChange={(e) => update({ subtitle: e.target.value })} />
                </Field>

                <div className="grid gap-3 md:grid-cols-2">
                  <Field label="按钮文案" hint="最多 12 字">
                    <input className={inputClass} value={form.ctaText} maxLength={12} onChange={(e) => update({ ctaText: e.target.value })} />
                  </Field>
                  <Field label="日期文案" hint="可留空">
                    <input className={inputClass} value={form.dateText} maxLength={30} onChange={(e) => update({ dateText: e.target.value })} />
                  </Field>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <Field label="点击跳转">
                    <select className={inputClass} value={form.linkType} onChange={(e) => update({ linkType: e.target.value, linkValue: ['shop', 'none'].includes(e.target.value) ? '' : form.linkValue })}>
                      {LINK_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                    </select>
                  </Field>
                  <Field label="跳转目标" hint={LINK_TYPES.find((item) => item.value === form.linkType)?.hint}>
                    <input className={inputClass} value={form.linkValue} disabled={['shop', 'none'].includes(form.linkType)}
                      onChange={(e) => update({ linkValue: e.target.value })} placeholder={['shop', 'none'].includes(form.linkType) ? '无需填写' : ''} />
                  </Field>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <Field label="排序" hint="越小越靠前">
                    <input type="number" min="0" max="999" className={inputClass} value={form.sortOrder}
                      onChange={(e) => update({ sortOrder: e.target.value === '' ? '' : Number(e.target.value) })} />
                  </Field>
                  <Field label="状态">
                    <label className="flex h-[38px] items-center gap-2 text-sm text-slate-600">
                      <input type="checkbox" checked={form.enabled} onChange={(e) => update({ enabled: e.target.checked })} />
                      启用（未启用不会同步到线上）
                    </label>
                  </Field>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between gap-2 border-t border-slate-100 px-5 py-3">
              <span className="text-[11px] text-slate-400">{form.image ? '图片已就绪' : '请先上传图片'}</span>
              <div className="flex gap-2">
                <button type="button" onClick={() => setOpen(false)} className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-600">取消</button>
                <button type="button" onClick={save} disabled={busy || uploading}
                  className="rounded-xl bg-budu-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                  {busy ? '保存中…' : '保存'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
