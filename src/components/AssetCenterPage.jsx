import { useEffect, useState } from 'react'
import JSZip from 'jszip'
import {
  ArrowLeft, Check, Download, Eye, FileText, FolderArchive, History, Lock, PackagePlus, Pencil, Plus, Search, Tags, Trash2, Upload, X,
} from 'lucide-react'
import { api } from '../utils/api'
import { useI18n } from '../i18n'

const STATUS_META = {
  normal: { label: '正常', cls: 'bg-emerald-50 text-emerald-600' },
  expiring: { label: '30天内到期', cls: 'bg-amber-50 text-amber-600' },
  expired: { label: '已过期', cls: 'bg-rose-50 text-rose-600' },
}

const PREVIEW_MAX_BYTES = 8 * 1024 * 1024

const inputCls = 'input'

function fmtDate(value) {
  if (!value) return ''
  const d = new Date(value)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function fmtTime(value) {
  if (!value) return '—'
  const d = new Date(value)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function fmtBytes(value) {
  const bytes = Number(value || 0)
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function compressImageFile(file, maxSize = 1600, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height))
        const w = Math.max(1, Math.round(img.width * scale))
        const h = Math.max(1, Math.round(img.height * scale))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        canvas.getContext('2d').drawImage(img, 0, 0, w, h)
        const dataUrl = canvas.toDataURL('image/jpeg', quality)
        const thumbSize = 240
        const tScale = Math.min(1, thumbSize / Math.max(img.width, img.height))
        const tw = Math.max(1, Math.round(img.width * tScale))
        const th = Math.max(1, Math.round(img.height * tScale))
        const tCanvas = document.createElement('canvas')
        tCanvas.width = tw
        tCanvas.height = th
        tCanvas.getContext('2d').drawImage(img, 0, 0, tw, th)
        const thumbnailDataUrl = tCanvas.toDataURL('image/jpeg', 0.7)
        const baseName = String(file.name || 'image').replace(/\.[^.]+$/, '') || 'image'
        resolve({ dataUrl, thumbnailDataUrl, fileName: `${baseName}.jpg`, mime: 'image/jpeg' })
      }
      img.onerror = () => reject(new Error('图片读取失败'))
      img.src = reader.result
    }
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']

function isImageType(type) {
  const t = String(type || '').toLowerCase()
  return t.includes('image') || IMAGE_EXT.includes(t) || IMAGE_EXT.some((ext) => t.endsWith('.' + ext))
}

function isPdfType(type) {
  const t = String(type || '').toLowerCase()
  return t === 'application/pdf' || t === 'pdf' || t.endsWith('.pdf')
}

function fileIcon(type) {
  if (isImageType(type)) return 'image'
  if (isPdfType(type)) return 'pdf'
  return 'file'
}

export default function AssetCenterPage({ user, onBack }) {
  const { t } = useI18n()
  const isDeveloper = user?.role === 'developer'
  const [tab, setTab] = useState('all')
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [categories, setCategories] = useState([])
  const [rows, setRows] = useState([])
  const [total, setTotal] = useState(0)
  const [overview, setOverview] = useState(null)
  const [reminders, setReminders] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tip, setTip] = useState('')
  const [uploadOpen, setUploadOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [preview, setPreview] = useState(null)
  const [versionsOpen, setVersionsOpen] = useState(null)
  const [packageOpen, setPackageOpen] = useState(false)
  const [grantsOpen, setGrantsOpen] = useState(false)
  const [logsOpen, setLogsOpen] = useState(false)
  const [catsOpen, setCatsOpen] = useState(false)

  const categoryName = (key) => (categories.find((c) => c.key === key) || { name: key }).name

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams()
      if (tab !== 'all') params.set('category', tab)
      if (q.trim()) params.set('q', q.trim())
      if (status) params.set('status', status)
      const [list, ov, rem, cats] = await Promise.all([
        api(`/v2/asset-center/files?${params.toString()}`),
        api('/v2/asset-center/overview'),
        api('/v2/asset-center/reminders'),
        api('/v2/asset-center/categories'),
      ])
      setRows(list.rows || [])
      setTotal(list.total || 0)
      setOverview(ov)
      setReminders(rem.rows || [])
      setCategories(cats.rows || [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [tab, status]) // eslint-disable-line react-hooks/exhaustive-deps

  const showTip = (text) => {
    setTip(text)
    setTimeout(() => setTip(''), 2500)
  }

  const downloadFile = async (file) => {
    try {
      const data = await api(`/v2/asset-center/files/${file.id}/download`)
      const link = document.createElement('a')
      link.href = data.dataUrl
      link.download = data.name || file.name
      link.click()
      showTip(`已下载 ${file.name}`)
    } catch (e) {
      setError(e.message)
    }
  }

  const removeFile = async (file) => {
    if (!window.confirm(`确认删除「${file.name}」？删除后不再显示（历史版本保留可审计）。`)) return
    try {
      await api(`/v2/asset-center/files/${file.id}`, { method: 'DELETE' })
      showTip('已删除')
      load()
    } catch (e) {
      setError(e.message)
    }
  }

  const makePackage = async (selected) => {
    if (!Array.isArray(selected) || selected.length === 0) return
    const zip = new JSZip()
    const folder = zip.folder('budu档案馆资料包')
    const names = []
    for (const file of selected) {
      const data = await api(`/v2/asset-center/files/${file.id}/download`)
      const safeName = String(data.name || file.name || 'file').trim()
      const base64 = String(data.dataUrl).split(',')[1] || ''
      folder.file(safeName, base64, { base64: true })
      names.push(file.name || safeName)
    }
    const now = new Date()
    const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
    const blob = await zip.generateAsync({ type: 'blob' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `budu档案馆资料包-${ymd}.zip`
    link.click()
    setTimeout(() => URL.revokeObjectURL(link.href), 5000)
    await api('/v2/asset-center/package-log', {
      method: 'POST',
      body: JSON.stringify({ files: names }),
    })
  }

  const card = 'rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm'

  return (
    <div>
      <div className="space-y-5 text-slate-800">
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={onBack} className="btn-secondary px-3 py-2" aria-label="返回"><ArrowLeft className="h-4 w-4" />返回</button>
          <div>
            <h2 className="text-xl font-bold">budu档案馆</h2>
            <p className="mt-0.5 text-[13px] text-slate-400">企业级文档中心 · 证照/资料/合同统一管理</p>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {isDeveloper && (
              <>
                <button onClick={() => setCatsOpen(true)} className="btn-secondary px-3 py-2"><Tags className="h-4 w-4" />管理分类</button>
                <button onClick={() => setGrantsOpen(true)} className="btn-secondary px-3 py-2"><Lock className="h-4 w-4" />授权</button>
                <button onClick={() => setLogsOpen(true)} className="btn-secondary px-3 py-2"><History className="h-4 w-4" />日志</button>
              </>
            )}
            <button onClick={() => setPackageOpen(true)} className="btn-secondary px-3 py-2"><PackagePlus className="h-4 w-4" />开店资料包</button>
            <button onClick={() => { setEditing(null); setUploadOpen(true) }} className="btn-primary px-3 py-2"><Upload className="h-4 w-4" />上传文件</button>
          </div>
        </div>

        {tip && <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-600">{tip}</div>}
        {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-600">{error}</div>}

        {overview && (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
            {[
              ['文件总数', overview.total],
              ['即将到期（30天内）', overview.expiring],
              ['已过期', overview.expired],
              ['本月新增', overview.addedThisMonth],
            ].map(([label, value]) => (
              <div key={label} className={card}>
                <p className="text-xs text-slate-400">{label}</p>
                <p className="mt-1 text-2xl font-black tabular-nums">{value}</p>
              </div>
            ))}
            <div className={card}>
              <p className="text-xs text-slate-400">存储用量</p>
              <p className="mt-1 text-2xl font-black tabular-nums">{fmtBytes(overview.storageBytes)}</p>
              <p className="mt-1 text-[11px] text-slate-400">共 {overview.versionCount || 0} 个版本 · 建议 {fmtBytes(overview.storageSoftLimitBytes)} 以内</p>
              {overview.storageBytes > (overview.storageSoftLimitBytes || 1) * 0.8 && (
                <p className="mt-1 text-[11px] font-semibold text-amber-600">存储接近上限，建议清理旧版本或迁移对象存储</p>
              )}
            </div>
            <div className={`${card} xl:col-span-1`}>
              <p className="text-xs text-slate-400">最近更新</p>
              <div className="mt-1 space-y-0.5">
                {(overview.recent || []).slice(0, 4).map((f) => (
                  <p key={f.id} className="truncate text-[11px] text-slate-500">{f.name}</p>
                ))}
              </div>
            </div>
          </div>
        )}

        {reminders.length > 0 && (
          <div className="rounded-2xl border border-amber-200/70 bg-amber-50/60 p-4">
            <p className="text-sm font-bold text-amber-700">到期提醒</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {reminders.slice(0, 8).map((r) => (
                <span key={r.id} className={`rounded-full px-2.5 py-1 text-xs font-semibold ${r.remindType === 'expired' ? 'bg-rose-100 text-rose-700' : 'bg-amber-100 text-amber-700'}`}>
                  {r.fileName} · {r.remindType === 'expired' ? '已过期' : `${r.daysLeft} 天到期`}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex flex-wrap gap-1 rounded-2xl bg-white p-1.5 shadow-sm">
            <button onClick={() => setTab('all')} className={`rounded-xl px-3.5 py-1.5 text-[13px] font-semibold transition ${tab === 'all' ? 'bg-budu-500 text-white' : 'text-slate-500 hover:bg-slate-50'}`}>全部（{total}）</button>
            {categories.map((c) => (
              <button key={c.key} onClick={() => setTab(c.key)} className={`rounded-xl px-3.5 py-1.5 text-[13px] font-semibold transition ${tab === c.key ? 'bg-budu-500 text-white' : 'text-slate-500 hover:bg-slate-50'}`}>{c.name}</button>
            ))}
          </div>
        </div>

        <div className="grid gap-2.5 md:grid-cols-2">
          <label className="relative"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索名称/描述/证照编号" className={`input pl-9 ${inputCls}`} /></label>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={`input ${inputCls}`}><option value="">全部状态</option><option value="normal">正常</option><option value="expiring">30天内到期</option><option value="expired">已过期</option></select>
        </div>

        {loading ? (
          <div className="grid place-items-center py-20 text-sm text-slate-400">正在加载…</div>
        ) : rows.length === 0 ? (
          <div className="grid place-items-center py-20 text-sm text-slate-300"><FileText className="mb-2 h-8 w-8 text-slate-300" />暂无符合条件的文件</div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {rows.map((f) => {
              const statusMeta = STATUS_META[f.status] || STATUS_META.normal
              const icon = fileIcon(f.fileType)
              return (
                <div key={f.id} className={card}>
                  <div className="flex items-start gap-3">
                    {f.thumbnail ? (
                      <img src={f.thumbnail} alt={f.name} className="h-11 w-11 shrink-0 rounded-xl object-cover" />
                    ) : (
                      <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-budu-50 text-budu-600">
                        {icon === 'image' ? <Eye className="h-5 w-5" /> : <FileText className="h-5 w-5" />}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold">{f.name}</p>
                      <p className="mt-0.5 text-xs text-slate-400">{categoryName(f.category)}</p>
                    </div>
                    {f.category === 'license' && (
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${statusMeta.cls}`}>{statusMeta.label}</span>
                    )}
                  </div>

                  <div className="mt-3 space-y-1 text-xs text-slate-500">
                    {(f.tags || []).length > 0 && <p className="flex flex-wrap gap-1 pt-0.5">{f.tags.map((tag) => <span key={tag} className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">{tag}</span>)}</p>}
                    {f.category === 'license' && (
                      <>
                        <p className="flex justify-between"><span className="text-slate-400">发证机关</span><span className="font-medium">{f.issuingAuthority || '—'}</span></p>
                        <p className="flex justify-between"><span className="text-slate-400">证照编号</span><span className="font-medium">{f.licenseNo || '—'}</span></p>
                        <p className="flex justify-between"><span className="text-slate-400">到期日期</span><span className="font-medium">{f.isPermanent ? '长期有效' : fmtDate(f.expiryDate) || '—'}</span></p>
                      </>
                    )}
                    {f.description && <p className="truncate pt-0.5 text-slate-400">{f.description}</p>}
                    <p className="flex justify-between pt-1 text-[11px] text-slate-400"><span>上传 {f.createdBy || '—'} · {fmtDate(f.createdAt)}</span><span>V{f.currentVersion}</span></p>
                    <p className="text-[11px] text-slate-400">最后更新 {fmtTime(f.updatedAt)}</p>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-1.5 border-t border-slate-100 pt-3">
                    <button onClick={() => setPreview(f)} className="flex items-center gap-1 rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-200"><Eye className="h-3.5 w-3.5" />预览</button>
                    <button onClick={() => downloadFile(f)} className="flex items-center gap-1 rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-200"><Download className="h-3.5 w-3.5" />下载</button>
                    <button onClick={() => { setEditing(f); setUploadOpen(true) }} className="flex items-center gap-1 rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-200"><Pencil className="h-3.5 w-3.5" />编辑</button>
                    <button onClick={() => setVersionsOpen(f)} className="flex items-center gap-1 rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-200"><History className="h-3.5 w-3.5" />版本</button>
                    <button onClick={() => removeFile(f)} className="ml-auto flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-rose-500 hover:bg-rose-50"><Trash2 className="h-3.5 w-3.5" />删除</button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {uploadOpen && <AssetFormModal user={user} file={editing} categories={categories} onClose={() => setUploadOpen(false)} onSaved={() => { setUploadOpen(false); load() }} />}
      {preview && <PreviewModal file={preview} onClose={() => setPreview(null)} />}
      {versionsOpen && <VersionsModal file={versionsOpen} onClose={() => setVersionsOpen(null)} onRestored={() => load()} />}
      {packageOpen && <PackageModal categories={categories} onClose={() => setPackageOpen(false)} onMake={makePackage} />}
      {grantsOpen && <GrantsModal onClose={() => setGrantsOpen(false)} />}
      {logsOpen && <LogsModal onClose={() => setLogsOpen(false)} />}
      {catsOpen && <CategoriesModal onClose={() => { setCatsOpen(false); load() }} />}
    </div>
  )
}

function ModalShell({ title, subtitle, onClose, children, wide }) {
  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onClose} />
      <div className={`relative max-h-[90vh] w-full ${wide ? 'max-w-3xl' : 'max-w-xl'} overflow-y-auto rounded-2xl bg-white p-6 shadow-lg`}>
        <div className="flex items-start gap-3">
          <div>
            <h3 className="text-lg font-bold">{title}</h3>
            {subtitle && <p className="mt-0.5 text-xs text-slate-400">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="ml-auto grid h-9 w-9 place-items-center rounded-xl bg-slate-100 text-slate-400" aria-label="关闭"><X className="h-5 w-5" /></button>
        </div>
        {children}
      </div>
    </div>
  )
}

const emptyForm = {
  name: '', category: 'license', tags: '', description: '',
  issuingAuthority: '', licenseNo: '', issueDate: '', expiryDate: '', isPermanent: false, fileName: '', note: '',
}

function AssetFormModal({ user, file, categories, onClose, onSaved }) {
  const isEdit = Boolean(file)
  const [form, setForm] = useState(() => ({
    ...emptyForm,
    ...(file ? {
      name: file.name, category: file.category,
      tags: (file.tags || []).join('、'), description: file.description,
      issuingAuthority: file.issuingAuthority, licenseNo: file.licenseNo,
      issueDate: file.issueDate ? String(file.issueDate).slice(0, 10) : '',
      expiryDate: file.expiryDate ? String(file.expiryDate).slice(0, 10) : '',
      isPermanent: file.isPermanent,
    } : {}),
  }))
  const [dataUrl, setDataUrl] = useState('')
  const [fileName, setFileName] = useState('')
  const [fileMime, setFileMime] = useState('')
  const [compressed, setCompressed] = useState(false)
  const [thumbnailDataUrl, setThumbnailDataUrl] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const update = (key, value) => setForm((s) => ({ ...s, [key]: value }))

  const pickFile = async (fileInput) => {
    const file = fileInput.files?.[0]
    if (!file) return
    setFileName(file.name)
    setFileMime(file.type || '')
    setCompressed(false)
    setThumbnailDataUrl('')
    setError('')
    try {
      const isImage = String(file.type || '').startsWith('image/') &&
        !String(file.type || '').includes('gif') &&
        !String(file.type || '').includes('svg')
      if (isImage) {
        const out = await compressImageFile(file)
        setFileName(out.fileName)
        setFileMime(out.mime)
        setDataUrl(out.dataUrl)
        setThumbnailDataUrl(out.thumbnailDataUrl)
        setCompressed(true)
      } else {
        const reader = new FileReader()
        reader.onload = () => setDataUrl(String(reader.result))
        reader.onerror = () => setError('读取文件失败')
        reader.readAsDataURL(file)
      }
    } catch (e) {
      setError(e.message || '读取文件失败')
    }
  }

  const save = async () => {
    if (!form.name.trim()) { setError('请填写文件名称'); return }
    if (!isEdit && !dataUrl) { setError('请选择要上传的文件'); return }
    setSaving(true)
    setError('')
    try {
      const body = {
        name: form.name, category: form.category,
        tags: form.tags.split(/[,，、]/).map((x) => x.trim()).filter(Boolean),
        description: form.description,
        issuingAuthority: form.issuingAuthority, licenseNo: form.licenseNo,
        issueDate: form.issueDate || null, expiryDate: form.expiryDate || null, isPermanent: form.isPermanent,
        ...(dataUrl ? { dataUrl, thumbnailDataUrl, fileName, fileType: fileMime || fileName.split('.').pop() || '', note: form.note } : {}),
      }
      if (isEdit) await api(`/v2/asset-center/files/${file.id}`, { method: 'PUT', body: JSON.stringify(body) })
      else await api('/v2/asset-center/files', { method: 'POST', body: JSON.stringify(body) })
      onSaved()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const field = 'input'
  return (
    <ModalShell title={isEdit ? '编辑文件资料' : '上传文件'} subtitle={isEdit ? `当前版本 V${file.currentVersion} · 最多保留 20 个版本` : '支持图片 / PDF / Office 等，单文件最大约 9MB；图片会自动压缩'} onClose={onClose} wide>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <label className="block text-xs font-semibold text-slate-500">文件名称<input value={form.name} onChange={(e) => update('name', e.target.value)} className={`mt-1 w-full ${field}`} /></label>
        <label className="block text-xs font-semibold text-slate-500">类别<select value={form.category} onChange={(e) => update('category', e.target.value)} className={`mt-1 w-full ${field}`}>{categories.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}</select></label>
        <label className="block text-xs font-semibold text-slate-500">标签（顿号分隔）<input value={form.tags} onChange={(e) => update('tags', e.target.value)} placeholder="营业执照、食品经营许可" className={`mt-1 w-full ${field}`} /></label>
        <label className="block text-xs font-semibold text-slate-500">描述<input value={form.description} onChange={(e) => update('description', e.target.value)} className={`mt-1 w-full ${field}`} /></label>
        {form.category === 'license' && (
          <>
            <label className="block text-xs font-semibold text-slate-500">发证机关<input value={form.issuingAuthority} onChange={(e) => update('issuingAuthority', e.target.value)} className={`mt-1 w-full ${field}`} /></label>
            <label className="block text-xs font-semibold text-slate-500">证照编号<input value={form.licenseNo} onChange={(e) => update('licenseNo', e.target.value)} className={`mt-1 w-full ${field}`} /></label>
            <label className="block text-xs font-semibold text-slate-500">发证日期<input type="date" value={form.issueDate} onChange={(e) => update('issueDate', e.target.value)} className={`mt-1 w-full ${field}`} /></label>
            <label className="block text-xs font-semibold text-slate-500">到期日期<input type="date" value={form.expiryDate} onChange={(e) => update('expiryDate', e.target.value)} className={`mt-1 w-full ${field}`} /></label>
            <label className="flex items-center gap-2 text-xs font-semibold text-slate-500"><input type="checkbox" checked={form.isPermanent} onChange={(e) => update('isPermanent', e.target.checked)} className="h-4 w-4 accent-budu-500" />长期有效</label>
          </>
        )}
        <div className="md:col-span-2">
          <label className="block text-xs font-semibold text-slate-500">
            {isEdit ? '更新文件（可选，选择后生成新版本）' : '选择文件'}
            <input type="file" onChange={(e) => pickFile(e.target)} className="mt-1 block w-full text-sm" />
          </label>
          {compressed && <p className="mt-1 text-[11px] font-medium text-emerald-600">图片已自动压缩（最长边 1600px），上传更流畅</p>}
          {isEdit && <input value={form.note} onChange={(e) => update('note', e.target.value)} placeholder="本次版本说明（可选）" className={`mt-2 w-full ${field}`} />}
        </div>
      </div>
      {error && <p className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-600">{error}</p>}
      <div className="mt-5 flex justify-end gap-2 border-t border-slate-100 pt-4">
        <button onClick={onClose} className="btn-secondary px-4 py-2">取消</button>
        <button onClick={save} disabled={saving} className="btn-primary px-5 py-2">{saving ? '保存中…' : isEdit ? '保存' : '上传'}</button>
      </div>
    </ModalShell>
  )
}

function PreviewModal({ file, onClose }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [downloading, setDownloading] = useState(false)
  const tooLarge = Number(file.fileSize || 0) > PREVIEW_MAX_BYTES
  useEffect(() => {
    if (tooLarge) return
    api(`/v2/asset-center/files/${file.id}/download`).then(setData).catch((e) => setError(e.message))
  }, [file.id, tooLarge])
  const download = async () => {
    setDownloading(true)
    setError('')
    try {
      const d = await api(`/v2/asset-center/files/${file.id}/download`)
      const link = document.createElement('a')
      link.href = d.dataUrl
      link.download = d.name || file.name
      link.click()
    } catch (e) {
      setError(e.message)
    } finally {
      setDownloading(false)
    }
  }
  const isImage = data && isImageType(data.fileType)
  return (
    <ModalShell title={`预览 · ${file.name}`} subtitle={tooLarge ? `文件较大 · ${fmtBytes(file.fileSize)}` : data ? `V${data.version} · ${data.name}` : '加载中…'} onClose={onClose} wide>
      <div className="mt-4 grid min-h-[320px] place-items-center rounded-xl bg-slate-50">
        {tooLarge ? (
          <div className="px-6 py-10 text-center">
            <p className="text-sm text-slate-500">文件较大（{fmtBytes(file.fileSize)}），为避免卡顿已关闭内嵌预览</p>
            <button onClick={download} disabled={downloading} className="btn-primary mt-4 px-5 py-2"><Download className="h-4 w-4" />{downloading ? '加载中…' : '下载查看'}</button>
          </div>
        ) : error ? <p className="text-sm text-rose-500">{error}</p> : !data ? <p className="text-sm text-slate-400">加载中…</p> : isImage ? (
          <img src={data.dataUrl} alt={file.name} className="max-h-[60vh] rounded-lg object-contain" />
        ) : isPdfType(data.fileType) ? (
          <iframe title={file.name} src={data.dataUrl} className="h-[60vh] w-full rounded-lg" />
        ) : (
          <a href={data.dataUrl} download={data.name} className="btn-primary px-5 py-2"><Download className="h-4 w-4" />该格式不支持内嵌预览，点击下载查看</a>
        )}
      </div>
    </ModalShell>
  )
}

function VersionsModal({ file, onClose, onRestored }) {
  const [versions, setVersions] = useState([])
  const [error, setError] = useState('')
  useEffect(() => {
    api(`/v2/asset-center/files/${file.id}/versions`).then((d) => setVersions(d.rows || [])).catch((e) => setError(e.message))
  }, [file.id])
  const restore = async (version) => {
    try {
      await api(`/v2/asset-center/files/${file.id}/restore`, { method: 'POST', body: JSON.stringify({ version }) })
      onRestored()
      onClose()
    } catch (e) {
      setError(e.message)
    }
  }
  return (
    <ModalShell title={`版本管理 · ${file.name}`} subtitle="每次更新保留旧版本，可恢复任意历史版本；最多保留 20 个版本，超出后最早的版本自动清理" onClose={onClose} wide>
      <div className="mt-4 space-y-2">
        {error && <p className="text-sm text-rose-500">{error}</p>}
        {versions.map((v) => (
          <div key={v.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-100 px-4 py-3">
            <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${v.version === file.currentVersion ? 'bg-budu-50 text-budu-600' : 'bg-slate-100 text-slate-500'}`}>V{v.version}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{v.name}</p>
              <p className="text-xs text-slate-400">{v.uploaderName || '—'} · {fmtTime(v.createdAt)}{v.note ? ` · ${v.note}` : ''}</p>
            </div>
            {v.version !== file.currentVersion && (
              <button onClick={() => restore(v.version)} className="btn-secondary px-3 py-1.5 text-xs">恢复此版本</button>
            )}
          </div>
        ))}
      </div>
    </ModalShell>
  )
}

function PackageModal({ categories, onClose, onMake }) {
  const [files, setFiles] = useState([])
  const [selected, setSelected] = useState(() => new Set())
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    api('/v2/asset-center/files?pageSize=200')
      .then((d) => setFiles(d.rows || []))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])
  const catName = (key) => (categories.find((c) => c.key === key) || { name: key }).name
  const groupDefs = categories.length > 0
    ? categories
    : [...new Set(files.map((f) => f.category))].map((key) => ({ key, name: key }))
  const groups = groupDefs
    .map((c) => ({ ...c, list: files.filter((f) => f.category === c.key) }))
    .filter((g) => g.list.length > 0)
  const allSelected = files.length > 0 && files.every((f) => selected.has(f.id))
  const toggle = (id) => setSelected((s) => {
    const n = new Set(s)
    if (n.has(id)) n.delete(id)
    else n.add(id)
    return n
  })
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(files.map((f) => f.id)))
  const run = async () => {
    if (selected.size === 0) return
    setBusy(true)
    try {
      await onMake(files.filter((f) => selected.has(f.id)))
    } finally {
      setBusy(false)
      onClose()
    }
  }
  return (
    <ModalShell title="生成开店资料包" subtitle="勾选要打包的文件，按原文件名生成 ZIP" onClose={onClose} wide>
      <div className="mt-4 space-y-3">
        {error && <p className="text-sm text-rose-500">{error}</p>}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-slate-400">已选 {selected.size} 个文件</p>
          <div className="flex gap-2">
            <button onClick={toggleAll} disabled={files.length === 0} className="btn-secondary px-2.5 py-1.5 text-xs">{allSelected ? '取消全选' : '全选'}</button>
            {selected.size > 0 && <button onClick={() => setSelected(new Set())} className="btn-secondary px-2.5 py-1.5 text-xs">清空</button>}
          </div>
        </div>
        {loading ? (
          <p className="py-10 text-center text-sm text-slate-400">加载中…</p>
        ) : groups.length === 0 ? (
          <p className="py-10 text-center text-sm text-slate-300">暂无文件可打包</p>
        ) : (
          <div className="max-h-[55vh] space-y-4 overflow-y-auto">
            {groups.map((g) => (
              <div key={g.key}>
                <p className="text-xs font-bold text-slate-500">{catName(g.key)}（{g.list.length}）</p>
                <div className="mt-1.5 space-y-1">
                  {g.list.map((f) => (
                    <label key={f.id} className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-100 px-3 py-2 text-sm transition hover:bg-slate-50">
                      <input type="checkbox" checked={selected.has(f.id)} onChange={() => toggle(f.id)} className="h-4 w-4 accent-budu-500" />
                      <span className="min-w-0 flex-1 truncate font-medium">{f.name}</span>
                      <span className="shrink-0 text-[11px] text-slate-400">V{f.currentVersion}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
          <button onClick={onClose} className="btn-secondary px-4 py-2">取消</button>
          <button onClick={run} disabled={selected.size === 0 || busy} className="btn-primary px-5 py-2"><FolderArchive className="h-4 w-4" />{busy ? '生成中…' : '生成并下载'}</button>
        </div>
      </div>
    </ModalShell>
  )
}

function CategoriesModal({ onClose }) {
  const [rows, setRows] = useState([])
  const [newName, setNewName] = useState('')
  const [editingKey, setEditingKey] = useState('')
  const [editName, setEditName] = useState('')
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')
  const [busy, setBusy] = useState(false)

  const load = async () => {
    try {
      const d = await api('/v2/asset-center/categories')
      setRows(d.rows || [])
    } catch (e) {
      setError(e.message)
    }
  }

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const add = async () => {
    const name = newName.trim()
    if (!name) {
      setError('请输入分类名称')
      return
    }
    setBusy(true)
    setError('')
    try {
      await api('/v2/asset-center/categories', { method: 'POST', body: JSON.stringify({ name }) })
      setNewName('')
      setSaved(`已新增分类：${name}`)
      await load()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const rename = async (row) => {
    const name = editName.trim()
    if (!name) {
      setError('请输入分类名称')
      return
    }
    setBusy(true)
    setError('')
    try {
      await api(`/v2/asset-center/categories/${row.key}`, { method: 'PUT', body: JSON.stringify({ name }) })
      setEditingKey('')
      setSaved(`已改名：${name}`)
      await load()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (row) => {
    if (!window.confirm(`确认删除分类「${row.name}」？该分类下的文件会自动移入「其他文件」。`)) return
    setBusy(true)
    setError('')
    try {
      await api(`/v2/asset-center/categories/${row.key}`, { method: 'DELETE' })
      setSaved(`已删除分类：${row.name}`)
      await load()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <ModalShell title="管理分类" subtitle="自定义分类可新增、改名、删除；内置分类名称固定" onClose={onClose} wide>
      <div className="mt-4 space-y-3">
        {error && <p className="text-sm text-rose-500">{error}</p>}
        {saved && <p className="rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-600">{saved}</p>}
        <div className="flex gap-2">
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="新分类名称（20字以内）" className="input flex-1" />
          <button onClick={add} disabled={busy || !newName.trim()} className="btn-primary px-4 py-2"><Plus className="h-4 w-4" />添加</button>
        </div>
        <div className="max-h-[50vh] space-y-1.5 overflow-y-auto">
          {rows.map((row) => (
            <div key={row.key} className="flex items-center gap-2 rounded-xl border border-slate-100 px-3 py-2.5">
              {editingKey === row.key ? (
                <>
                  <input value={editName} onChange={(e) => setEditName(e.target.value)} className="input flex-1" />
                  <button onClick={() => rename(row)} disabled={busy || !editName.trim()} className="btn-primary px-3 py-1.5 text-xs">保存</button>
                  <button onClick={() => setEditingKey('')} className="btn-secondary px-3 py-1.5 text-xs">取消</button>
                </>
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{row.name}</span>
                  {row.builtin ? (
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-400">内置</span>
                  ) : (
                    <>
                      <button onClick={() => { setEditingKey(row.key); setEditName(row.name); setError(''); setSaved('') }} className="btn-secondary px-3 py-1.5 text-xs"><Pencil className="h-3 w-3" />改名</button>
                      <button onClick={() => remove(row)} disabled={busy} className="btn-secondary px-3 py-1.5 text-xs text-rose-500 hover:bg-rose-50"><Trash2 className="h-3 w-3" />删除</button>
                    </>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
        <div className="flex justify-end border-t border-slate-100 pt-3">
          <button onClick={onClose} className="btn-secondary px-4 py-2">关闭</button>
        </div>
      </div>
    </ModalShell>
  )
}

function GrantsModal({ onClose }) {
  const [users, setUsers] = useState([])
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')
  useEffect(() => {
    api('/v2/asset-center/grants').then((d) => setUsers(d.users || [])).catch((e) => setError(e.message))
  }, [])
  const toggle = async (u) => {
    try {
      await api('/v2/asset-center/grants', { method: 'PUT', body: JSON.stringify({ userId: u.id, granted: !u.assetCenter }) })
      setUsers((list) => list.map((x) => x.id === u.id ? { ...x, assetCenter: !u.assetCenter } : x))
      try {
        const bc = 'BroadcastChannel' in window ? new BroadcastChannel('budu-auth-sync') : null
        if (bc) {
          bc.postMessage({ type: 'auth-changed' })
          bc.close()
        }
      } catch { /* 同浏览器多标签页即时同步，失败时靠轮询兜底 */ }
      setSaved(`已保存：${u.username} ${!u.assetCenter ? '已授权' : '已取消授权'}，对方 3 秒内自动生效`)
    } catch (e) {
      setError(e.message)
    }
  }
  return (
    <ModalShell title="资产中心授权" subtitle="默认仅开发者可见；可为店长/店员单独开通查看权限" onClose={onClose} wide>
      <div className="mt-4 space-y-2">
        {error && <p className="text-sm text-rose-500">{error}</p>}
        {saved && <p className="rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-600">{saved}</p>}
        {users.filter((u) => u.role !== 'developer').map((u) => (
          <div key={u.id} className="flex items-center gap-3 rounded-xl border border-slate-100 px-4 py-3">
            <div className="min-w-0 flex-1"><p className="text-sm font-semibold">{u.username}</p><p className="text-xs text-slate-400">{u.role === 'manager' ? '店长·区域负责人' : '店员'}</p></div>
            <button onClick={() => toggle(u)} className={`rounded-full px-3 py-1.5 text-xs font-bold ${u.assetCenter ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-500'}`}>
              {u.assetCenter ? <><Check className="mr-1 inline h-3 w-3" />已授权</> : '未授权'}
            </button>
          </div>
        ))}
      </div>
    </ModalShell>
  )
}

function LogsModal({ onClose }) {
  const [logs, setLogs] = useState([])
  const [error, setError] = useState('')
  useEffect(() => {
    api('/v2/asset-center/logs').then((d) => setLogs(d.rows || [])).catch((e) => setError(e.message))
  }, [])
  const actionLabel = { upload: '上传', update: '修改', upload_version: '更新版本', restore: '恢复', delete: '删除', download: '下载', grant: '授权', revoke: '取消授权', package: '开店资料包', category_add: '新增分类', category_rename: '分类改名', category_delete: '删除分类' }
  return (
    <ModalShell title="操作日志" subtitle="上传/修改/下载/删除等关键操作留痕" onClose={onClose} wide>
      <div className="mt-4 max-h-[60vh] space-y-2 overflow-y-auto">
        {error && <p className="text-sm text-rose-500">{error}</p>}
        {logs.map((log) => (
          <div key={log.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-100 px-4 py-2.5 text-sm">
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-bold text-slate-600">{actionLabel[log.action] || log.action}</span>
            <span className="min-w-0 flex-1 truncate font-medium">{log.fileName || log.detail}</span>
            <span className="text-xs text-slate-400">{log.username} · {fmtTime(log.createdAt)}</span>
          </div>
        ))}
      </div>
    </ModalShell>
  )
}
