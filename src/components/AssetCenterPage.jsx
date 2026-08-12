import { useEffect, useMemo, useState } from 'react'
import JSZip from 'jszip'
import {
  ArrowLeft, Check, Download, Eye, FileText, FolderArchive, History, Lock, Moon, PackagePlus, Pencil, Plus, Search, Sun, Trash2, Upload, X,
} from 'lucide-react'
import { api } from '../utils/api'
import { allStores } from '../utils/selectors'
import { useI18n } from '../i18n'

const CATEGORIES = [
  ['license', '企业证照'],
  ['store', '门店资料'],
  ['staff', '人员资料'],
  ['brand', '品牌资料'],
  ['contract', '合同中心'],
  ['operation', '经营资料'],
  ['other', '其他文件'],
]

const STATUS_META = {
  normal: { label: '正常', cls: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300' },
  expiring: { label: '30天内到期', cls: 'bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300' },
  expired: { label: '已过期', cls: 'bg-rose-50 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300' },
}

const inputCls = 'input dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:placeholder-slate-500'

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

function fileIcon(type) {
  if (!type) return 'file'
  if (type.includes('image')) return 'image'
  if (type.includes('pdf')) return 'pdf'
  return 'file'
}

export default function AssetCenterPage({ user, onBack }) {
  const { t } = useI18n()
  const isDeveloper = user?.role === 'developer'
  const [dark, setDark] = useState(false)
  const [tab, setTab] = useState('all')
  const [q, setQ] = useState('')
  const [store, setStore] = useState('')
  const [company, setCompany] = useState('')
  const [status, setStatus] = useState('')
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

  const stores = useMemo(() => allStores(), [])
  const storeName = (key) => stores.find((s) => s.key === key)?.name || key || '—'

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams()
      if (tab !== 'all') params.set('category', tab)
      if (q.trim()) params.set('q', q.trim())
      if (store) params.set('store', store)
      if (company.trim()) params.set('company', company.trim())
      if (status) params.set('status', status)
      const [list, ov, rem] = await Promise.all([
        api(`/v2/asset-center/files?${params.toString()}`),
        api('/v2/asset-center/overview'),
        api('/v2/asset-center/reminders'),
      ])
      setRows(list.rows || [])
      setTotal(list.total || 0)
      setOverview(ov)
      setReminders(rem.rows || [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [tab, store, status]) // eslint-disable-line react-hooks/exhaustive-deps

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

  const makePackage = async (storeKey) => {
    const files = rows.filter((r) => r.storeKey === storeKey)
    const match = (keywords, category) => files.find((f) => {
      if (category && f.category !== category) return false
      const hay = `${f.name} ${(f.tags || []).join(' ')}`
      return keywords.some((k) => hay.includes(k))
    })
    const wanted = [
      { key: '营业执照', category: 'license', keywords: ['营业执照', '执照'] },
      { key: '食品经营许可证', category: 'license', keywords: ['食品经营许可', '经营许可'] },
      { key: '法人身份证', category: 'staff', keywords: ['法人', '身份证'] },
      { key: '品牌logo', category: 'brand', keywords: ['logo', '商标', '标志'] },
      { key: '公司简介', category: 'brand', keywords: ['公司简介', '简介'] },
    ]
    const picked = wanted.map((w) => ({ ...w, file: match(w.keywords, w.category) }))
    const zip = new JSZip()
    const folder = zip.folder(`开店资料包-${storeName(storeKey)}`)
    for (const item of picked) {
      if (!item.file) continue
      const data = await api(`/v2/asset-center/files/${item.file.id}/download`)
      const ext = (data.name || item.file.name).split('.').pop() || 'bin'
      const safeName = `${item.key}.${ext}`
      const base64 = String(data.dataUrl).split(',')[1] || ''
      folder.file(safeName, base64, { base64: true })
    }
    const missing = picked.filter((p) => !p.file).map((p) => p.key)
    if (missing.length) showTip(`以下资料暂缺，已跳过：${missing.join('、')}`)
    const blob = await zip.generateAsync({ type: 'blob' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `开店资料包-${storeName(storeKey)}.zip`
    link.click()
    setTimeout(() => URL.revokeObjectURL(link.href), 5000)
    await api('/v2/asset-center/package-log', {
      method: 'POST',
      body: JSON.stringify({ storeKey, files: picked.filter((p) => p.file).map((p) => p.key) }),
    })
  }

  const rootCls = dark ? 'dark' : ''
  const card = 'rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-800'

  return (
    <div className={rootCls}>
      <div className="space-y-5 text-slate-800 dark:text-slate-100">
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={onBack} className="btn-secondary px-3 py-2" aria-label="返回"><ArrowLeft className="h-4 w-4" />返回</button>
          <div>
            <h2 className="text-xl font-bold">企业资产中心</h2>
            <p className="mt-0.5 text-[13px] text-slate-400 dark:text-slate-400">企业级文档中心 · 证照/资料/合同统一管理</p>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <button onClick={() => setDark((v) => !v)} className="btn-secondary px-3 py-2" aria-label="深色模式">
              {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              {dark ? '浅色' : '深色'}
            </button>
            {isDeveloper && (
              <>
                <button onClick={() => setGrantsOpen(true)} className="btn-secondary px-3 py-2"><Lock className="h-4 w-4" />授权</button>
                <button onClick={() => setLogsOpen(true)} className="btn-secondary px-3 py-2"><History className="h-4 w-4" />日志</button>
              </>
            )}
            <button onClick={() => setPackageOpen(true)} className="btn-secondary px-3 py-2"><PackagePlus className="h-4 w-4" />开店资料包</button>
            <button onClick={() => { setEditing(null); setUploadOpen(true) }} className="btn-primary px-3 py-2"><Upload className="h-4 w-4" />上传文件</button>
          </div>
        </div>

        {tip && <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-600 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">{tip}</div>}
        {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-600 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">{error}</div>}

        {overview && (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-5">
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
          <div className="rounded-2xl border border-amber-200/70 bg-amber-50/60 p-4 dark:border-amber-500/30 dark:bg-amber-500/10">
            <p className="text-sm font-bold text-amber-700 dark:text-amber-300">到期提醒</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {reminders.slice(0, 8).map((r) => (
                <span key={r.id} className={`rounded-full px-2.5 py-1 text-xs font-semibold ${r.remindType === 'expired' ? 'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300'}`}>
                  {r.fileName} · {r.remindType === 'expired' ? '已过期' : `${r.daysLeft} 天到期`}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex flex-wrap gap-1 rounded-2xl bg-white p-1.5 shadow-sm dark:bg-slate-800 dark:ring-1 dark:ring-slate-700">
            <button onClick={() => setTab('all')} className={`rounded-xl px-3.5 py-1.5 text-[13px] font-semibold transition ${tab === 'all' ? 'bg-budu-500 text-white' : 'text-slate-500 hover:bg-slate-50 dark:text-slate-400 dark:hover:bg-slate-700'}`}>全部（{total}）</button>
            {CATEGORIES.map(([key, label]) => (
              <button key={key} onClick={() => setTab(key)} className={`rounded-xl px-3.5 py-1.5 text-[13px] font-semibold transition ${tab === key ? 'bg-budu-500 text-white' : 'text-slate-500 hover:bg-slate-50 dark:text-slate-400 dark:hover:bg-slate-700'}`}>{label}</button>
            ))}
          </div>
        </div>

        <div className="grid gap-2.5 md:grid-cols-2 xl:grid-cols-4">
          <label className="relative"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索名称/公司/描述/证照编号" className={`input pl-9 ${inputCls}`} /></label>
          <select value={store} onChange={(e) => setStore(e.target.value)} className={`input ${inputCls}`}><option value="">全部门店</option>{stores.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}</select>
          <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="所属公司" className={`input ${inputCls}`} />
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
                    <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-budu-50 text-budu-600 dark:bg-budu-500/15 dark:text-budu-300">
                      {icon === 'image' ? <Eye className="h-5 w-5" /> : <FileText className="h-5 w-5" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold">{f.name}</p>
                      <p className="mt-0.5 text-xs text-slate-400">{(CATEGORIES.find((c) => c[0] === f.category) || ['', f.category])[1]} · {storeName(f.storeKey)}</p>
                    </div>
                    {f.category === 'license' && (
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${statusMeta.cls}`}>{statusMeta.label}</span>
                    )}
                  </div>

                  <div className="mt-3 space-y-1 text-xs text-slate-500 dark:text-slate-400">
                    <p className="flex justify-between"><span className="text-slate-400">所属公司</span><span className="font-medium text-slate-700 dark:text-slate-300">{f.company || '—'}</span></p>
                    {(f.tags || []).length > 0 && <p className="flex flex-wrap gap-1 pt-0.5">{f.tags.map((tag) => <span key={tag} className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500 dark:bg-slate-700 dark:text-slate-300">{tag}</span>)}</p>}
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

                  <div className="mt-3 flex flex-wrap gap-1.5 border-t border-slate-100 pt-3 dark:border-slate-700">
                    <button onClick={() => setPreview(f)} className="flex items-center gap-1 rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"><Eye className="h-3.5 w-3.5" />预览</button>
                    <button onClick={() => downloadFile(f)} className="flex items-center gap-1 rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"><Download className="h-3.5 w-3.5" />下载</button>
                    <button onClick={() => { setEditing(f); setUploadOpen(true) }} className="flex items-center gap-1 rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"><Pencil className="h-3.5 w-3.5" />编辑</button>
                    <button onClick={() => setVersionsOpen(f)} className="flex items-center gap-1 rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"><History className="h-3.5 w-3.5" />版本</button>
                    <button onClick={() => removeFile(f)} className="ml-auto flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10"><Trash2 className="h-3.5 w-3.5" />删除</button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {uploadOpen && <AssetFormModal user={user} file={editing} stores={stores} onClose={() => setUploadOpen(false)} onSaved={() => { setUploadOpen(false); load() }} />}
      {preview && <PreviewModal file={preview} onClose={() => setPreview(null)} />}
      {versionsOpen && <VersionsModal file={versionsOpen} onClose={() => setVersionsOpen(null)} onRestored={() => load()} />}
      {packageOpen && <PackageModal stores={stores} rows={rows} onClose={() => setPackageOpen(false)} onMake={makePackage} />}
      {grantsOpen && <GrantsModal onClose={() => setGrantsOpen(false)} />}
      {logsOpen && <LogsModal onClose={() => setLogsOpen(false)} />}
    </div>
  )
}

function ModalShell({ title, subtitle, onClose, children, wide }) {
  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onClose} />
      <div className={`relative max-h-[90vh] w-full ${wide ? 'max-w-3xl' : 'max-w-xl'} overflow-y-auto rounded-2xl bg-white p-6 shadow-lg dark:bg-slate-800 dark:text-slate-100`}>
        <div className="flex items-start gap-3">
          <div>
            <h3 className="text-lg font-bold">{title}</h3>
            {subtitle && <p className="mt-0.5 text-xs text-slate-400">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="ml-auto grid h-9 w-9 place-items-center rounded-xl bg-slate-100 text-slate-400 dark:bg-slate-700 dark:text-slate-300" aria-label="关闭"><X className="h-5 w-5" /></button>
        </div>
        {children}
      </div>
    </div>
  )
}

const emptyForm = {
  name: '', category: 'license', company: '', storeKey: '', tags: '', description: '',
  issuingAuthority: '', licenseNo: '', issueDate: '', expiryDate: '', isPermanent: false, fileName: '', note: '',
}

function AssetFormModal({ user, file, stores, onClose, onSaved }) {
  const isEdit = Boolean(file)
  const [form, setForm] = useState(() => ({
    ...emptyForm,
    ...(file ? {
      name: file.name, category: file.category, company: file.company, storeKey: file.storeKey,
      tags: (file.tags || []).join('、'), description: file.description,
      issuingAuthority: file.issuingAuthority, licenseNo: file.licenseNo,
      issueDate: file.issueDate ? String(file.issueDate).slice(0, 10) : '',
      expiryDate: file.expiryDate ? String(file.expiryDate).slice(0, 10) : '',
      isPermanent: file.isPermanent,
    } : {}),
  }))
  const [dataUrl, setDataUrl] = useState('')
  const [fileName, setFileName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const update = (key, value) => setForm((s) => ({ ...s, [key]: value }))

  const pickFile = (fileInput) => {
    const file = fileInput.files?.[0]
    if (!file) return
    setFileName(file.name)
    setError('')
    const reader = new FileReader()
    reader.onload = () => setDataUrl(String(reader.result))
    reader.onerror = () => setError('读取文件失败')
    reader.readAsDataURL(file)
  }

  const save = async () => {
    if (!form.name.trim()) { setError('请填写文件名称'); return }
    if (!isEdit && !dataUrl) { setError('请选择要上传的文件'); return }
    setSaving(true)
    setError('')
    try {
      const body = {
        name: form.name, category: form.category, company: form.company, storeKey: form.storeKey,
        tags: form.tags.split(/[,，、]/).map((x) => x.trim()).filter(Boolean),
        description: form.description,
        issuingAuthority: form.issuingAuthority, licenseNo: form.licenseNo,
        issueDate: form.issueDate || null, expiryDate: form.expiryDate || null, isPermanent: form.isPermanent,
        ...(dataUrl ? { dataUrl, fileName, fileType: fileName.split('.').pop() || '', note: form.note } : {}),
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

  const field = 'input dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100'
  return (
    <ModalShell title={isEdit ? '编辑文件资料' : '上传文件'} subtitle={isEdit ? `当前版本 V${file.currentVersion}` : '支持图片 / PDF / Office 等，单文件最大约 9MB'} onClose={onClose} wide>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400">文件名称<input value={form.name} onChange={(e) => update('name', e.target.value)} className={`mt-1 w-full ${field}`} /></label>
        <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400">类别<select value={form.category} onChange={(e) => update('category', e.target.value)} className={`mt-1 w-full ${field}`}>{CATEGORIES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400">所属公司<input value={form.company} onChange={(e) => update('company', e.target.value)} className={`mt-1 w-full ${field}`} /></label>
        <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400">所属门店<select value={form.storeKey} onChange={(e) => update('storeKey', e.target.value)} className={`mt-1 w-full ${field}`}><option value="">不指定</option>{stores.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}</select></label>
        <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400">标签（顿号分隔）<input value={form.tags} onChange={(e) => update('tags', e.target.value)} placeholder="营业执照、食品经营许可" className={`mt-1 w-full ${field}`} /></label>
        <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400">描述<input value={form.description} onChange={(e) => update('description', e.target.value)} className={`mt-1 w-full ${field}`} /></label>
        {form.category === 'license' && (
          <>
            <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400">发证机关<input value={form.issuingAuthority} onChange={(e) => update('issuingAuthority', e.target.value)} className={`mt-1 w-full ${field}`} /></label>
            <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400">证照编号<input value={form.licenseNo} onChange={(e) => update('licenseNo', e.target.value)} className={`mt-1 w-full ${field}`} /></label>
            <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400">发证日期<input type="date" value={form.issueDate} onChange={(e) => update('issueDate', e.target.value)} className={`mt-1 w-full ${field}`} /></label>
            <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400">到期日期<input type="date" value={form.expiryDate} onChange={(e) => update('expiryDate', e.target.value)} className={`mt-1 w-full ${field}`} /></label>
            <label className="flex items-center gap-2 text-xs font-semibold text-slate-500 dark:text-slate-400"><input type="checkbox" checked={form.isPermanent} onChange={(e) => update('isPermanent', e.target.checked)} className="h-4 w-4 accent-budu-500" />长期有效</label>
          </>
        )}
        <div className="md:col-span-2">
          <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400">
            {isEdit ? '更新文件（可选，选择后生成新版本）' : '选择文件'}
            <input type="file" onChange={(e) => pickFile(e.target)} className="mt-1 block w-full text-sm" />
          </label>
          {isEdit && <input value={form.note} onChange={(e) => update('note', e.target.value)} placeholder="本次版本说明（可选）" className={`mt-2 w-full ${field}`} />}
        </div>
      </div>
      {error && <p className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-600 dark:bg-rose-500/10 dark:text-rose-300">{error}</p>}
      <div className="mt-5 flex justify-end gap-2 border-t border-slate-100 pt-4 dark:border-slate-700">
        <button onClick={onClose} className="btn-secondary px-4 py-2">取消</button>
        <button onClick={save} disabled={saving} className="btn-primary px-5 py-2">{saving ? '保存中…' : isEdit ? '保存' : '上传'}</button>
      </div>
    </ModalShell>
  )
}

function PreviewModal({ file, onClose }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    api(`/v2/asset-center/files/${file.id}/download`).then(setData).catch((e) => setError(e.message))
  }, [file.id])
  const isImage = data && String(data.fileType).includes('image')
  return (
    <ModalShell title={`预览 · ${file.name}`} subtitle={data ? `V${data.version} · ${data.name}` : '加载中…'} onClose={onClose} wide>
      <div className="mt-4 grid min-h-[320px] place-items-center rounded-xl bg-slate-50 dark:bg-slate-900">
        {error ? <p className="text-sm text-rose-500">{error}</p> : !data ? <p className="text-sm text-slate-400">加载中…</p> : isImage ? (
          <img src={data.dataUrl} alt={file.name} className="max-h-[60vh] rounded-lg object-contain" />
        ) : data.fileType === 'application/pdf' ? (
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
    <ModalShell title={`版本管理 · ${file.name}`} subtitle="每次更新保留旧版本，可恢复任意历史版本" onClose={onClose} wide>
      <div className="mt-4 space-y-2">
        {error && <p className="text-sm text-rose-500">{error}</p>}
        {versions.map((v) => (
          <div key={v.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-100 px-4 py-3 dark:border-slate-700">
            <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${v.version === file.currentVersion ? 'bg-budu-50 text-budu-600 dark:bg-budu-500/15 dark:text-budu-300' : 'bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-300'}`}>V{v.version}</span>
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

function PackageModal({ stores, rows, onClose, onMake }) {
  const [storeKey, setStoreKey] = useState('')
  const [busy, setBusy] = useState(false)
  const run = async () => {
    if (!storeKey) return
    setBusy(true)
    try {
      await onMake(storeKey)
    } finally {
      setBusy(false)
      onClose()
    }
  }
  return (
    <ModalShell title="生成开店资料包" subtitle="自动收集营业执照、食品经营许可证、法人身份证、品牌 logo、公司简介并打包 ZIP" onClose={onClose}>
      <div className="mt-4 space-y-3">
        <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400">选择门店<select value={storeKey} onChange={(e) => setStoreKey(e.target.value)} className="input mt-1 w-full dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"><option value="">请选择</option>{stores.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}</select></label>
        <p className="text-xs text-slate-400">提示：请先在该门店上传对应资料并打上合适标签；缺失的资料会自动跳过并在打包时提示。</p>
        <div className="flex justify-end gap-2 border-t border-slate-100 pt-4 dark:border-slate-700">
          <button onClick={onClose} className="btn-secondary px-4 py-2">取消</button>
          <button onClick={run} disabled={!storeKey || busy} className="btn-primary px-5 py-2"><FolderArchive className="h-4 w-4" />{busy ? '生成中…' : '生成并下载'}</button>
        </div>
      </div>
    </ModalShell>
  )
}

function GrantsModal({ onClose }) {
  const [users, setUsers] = useState([])
  const [error, setError] = useState('')
  useEffect(() => {
    api('/v2/asset-center/grants').then((d) => setUsers(d.users || [])).catch((e) => setError(e.message))
  }, [])
  const toggle = async (u) => {
    try {
      await api('/v2/asset-center/grants', { method: 'PUT', body: JSON.stringify({ userId: u.id, granted: !u.assetCenter }) })
      setUsers((list) => list.map((x) => x.id === u.id ? { ...x, assetCenter: !u.assetCenter } : x))
    } catch (e) {
      setError(e.message)
    }
  }
  return (
    <ModalShell title="资产中心授权" subtitle="默认仅开发者可见；可为店长/店员单独开通查看权限" onClose={onClose} wide>
      <div className="mt-4 space-y-2">
        {error && <p className="text-sm text-rose-500">{error}</p>}
        {users.filter((u) => u.role !== 'developer').map((u) => (
          <div key={u.id} className="flex items-center gap-3 rounded-xl border border-slate-100 px-4 py-3 dark:border-slate-700">
            <div className="min-w-0 flex-1"><p className="text-sm font-semibold">{u.username}</p><p className="text-xs text-slate-400">{u.role === 'manager' ? '店长·区域负责人' : '店员'}</p></div>
            <button onClick={() => toggle(u)} className={`rounded-full px-3 py-1.5 text-xs font-bold ${u.assetCenter ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300' : 'bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-300'}`}>
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
  const actionLabel = { upload: '上传', update: '修改', upload_version: '更新版本', restore: '恢复', delete: '删除', download: '下载', grant: '授权', revoke: '取消授权', package: '开店资料包' }
  return (
    <ModalShell title="操作日志" subtitle="上传/修改/下载/删除等关键操作留痕" onClose={onClose} wide>
      <div className="mt-4 max-h-[60vh] space-y-2 overflow-y-auto">
        {error && <p className="text-sm text-rose-500">{error}</p>}
        {logs.map((log) => (
          <div key={log.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-100 px-4 py-2.5 text-sm dark:border-slate-700">
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-bold text-slate-600 dark:bg-slate-700 dark:text-slate-300">{actionLabel[log.action] || log.action}</span>
            <span className="min-w-0 flex-1 truncate font-medium">{log.fileName || log.detail}</span>
            <span className="text-xs text-slate-400">{log.username} · {fmtTime(log.createdAt)}</span>
          </div>
        ))}
      </div>
    </ModalShell>
  )
}
