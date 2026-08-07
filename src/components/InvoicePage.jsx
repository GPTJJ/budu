import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Building2, Camera, ImageUp, Loader2, Plus, Receipt, Trash2, User } from 'lucide-react'
import { allStores, storeName } from '../utils/selectors'
import { api } from '../utils/api'
import { useI18n } from '../i18n'

const inputCls =
  'w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none transition focus:border-budu-400 focus:ring-2 focus:ring-budu-100'

const yuan = (cents) => (Number(cents || 0) / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtTime = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片读取失败'))
    img.src = src
  })
}

/** 手机拍照图片统一压缩并转为 JPEG：解决 HEIC 不支持、图片过大、方向异常等问题 */
async function normalizeInvoiceImage(dataUrl, fileType) {
  const plain = /^image\/(jpe?g|png|webp|bmp)$/i.test(fileType || '')
  if (plain && dataUrl.length < 1.5 * 1024 * 1024) return dataUrl
  const img = await loadImage(dataUrl)
  const maxSide = 2000
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth || 1, img.naturalHeight || 1))
  const w = Math.max(1, Math.round((img.naturalWidth || 1) * scale))
  const h = Math.max(1, Math.round((img.naturalHeight || 1) * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(img, 0, 0, w, h)
  return canvas.toDataURL('image/jpeg', 0.86)
}

export default function InvoicePage({ currentUser, onBack }) {
  const { t } = useI18n()
  const [month, setMonth] = useState(`${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`)
  const [store, setStore] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [rows, setRows] = useState([])
  const [companies, setCompanies] = useState([])
  const [form, setForm] = useState({
    storeKey: allStores()[0]?.key || '',
    titleType: 'company',
    companyName: '',
    taxNo: '',
    amount: '',
    category: '商品',
    email: '',
  })
  const [focused, setFocused] = useState(false)
  const [error, setError] = useState('')
  const [savedTip, setSavedTip] = useState('')
  const [ocrReady, setOcrReady] = useState(null)
  const [ocrBusy, setOcrBusy] = useState(false)
  const [preview, setPreview] = useState('')
  const nameInputRef = useRef(null)
  const fileInputRef = useRef(null)
  const cameraInputRef = useRef(null)

  useEffect(() => {
    api('/v2/invoices/ocr-status')
      .then((d) => setOcrReady(Boolean(d && d.configured)))
      .catch(() => setOcrReady(false))
  }, [])

  const load = async () => {
    setError('')
    const qs = new URLSearchParams({ month })
    if (store !== 'all') qs.set('store', store)
    if (statusFilter !== 'all') qs.set('status', statusFilter)
    try {
      const [list, cps] = await Promise.all([api(`/v2/invoices?${qs}`), api('/v2/invoices/companies')])
      setRows(list.rows || [])
      setCompanies(cps.rows || [])
    } catch (err) {
      setError(t(err.message))
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, store, statusFilter])

  const suggestions = useMemo(() => {
    const q = form.companyName.trim().toLowerCase()
    if (!q) return companies.slice(0, 8)
    return companies.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8)
  }, [companies, form.companyName])

  const setField = (key, value) => setForm((s) => ({ ...s, [key]: value }))

  const pickCompany = (c) => {
    setField('companyName', c.name)
    setField('taxNo', c.taxNo || '')
    setFocused(false)
    nameInputRef.current?.blur()
  }

  const changeName = (value) => {
    setField('companyName', value)
    const hit = companies.find((c) => c.name.toLowerCase() === value.trim().toLowerCase())
    setField('taxNo', hit ? hit.taxNo || '' : '')
    setFocused(true)
  }

  const submit = async () => {
    setError('')
    const name = form.companyName.trim()
    if (!name) {
      setError(t(form.titleType === 'company' ? '请填写公司名称' : '请填写抬头名称'))
      return
    }
    const cents = Math.round((Number(form.amount) || 0) * 100)
    if (!(cents > 0)) {
      setError(t('请填写正确的开票金额'))
      return
    }
    if (!form.email.trim()) {
      setError(t('请填写邮箱'))
      return
    }
    try {
      await api('/v2/invoices', {
        method: 'POST',
        body: JSON.stringify({
          storeKey: form.storeKey,
          titleType: form.titleType,
          companyName: name,
          taxNo: form.taxNo.trim(),
          amountCents: cents,
          category: form.category.trim() || '其他',
          email: form.email.trim(),
        }),
      })
      setForm((s) => ({ ...s, companyName: '', taxNo: '', amount: '', email: '' }))
      setSavedTip(t('发票申请已提交 ✓'))
      setTimeout(() => setSavedTip(''), 2000)
      await load()
    } catch (err) {
      setError(t(err.message))
    }
  }

  const handleFile = async (e) => {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setError(t('请上传图片文件'))
      return
    }
    if (file.size > 25 * 1024 * 1024) {
      setError(t('图片不能超过 25MB'))
      return
    }
    const reader = new FileReader()
    reader.onload = async () => {
      const original = String(reader.result || '')
      setPreview(original)
      setOcrBusy(true)
      setError('')
      try {
        const dataUrl = await normalizeInvoiceImage(original, file.type)
        const d = await api('/v2/invoices/ocr', {
          method: 'POST',
          body: JSON.stringify({ imageBase64: dataUrl }),
        })
        const ex = d.extracted || {}
        setForm((s) => ({
          ...s,
          titleType: ex.titleType || s.titleType,
          companyName: ex.companyName || s.companyName,
          taxNo: ex.taxNo || s.taxNo,
          amount: ex.amountYuan != null ? String(ex.amountYuan) : s.amount,
        }))
        setSavedTip(t('识别成功，信息已自动填入，请核对后提交'))
        setTimeout(() => setSavedTip(''), 3000)
      } catch (err) {
        setError(t(err.message))
      } finally {
        setOcrBusy(false)
      }
    }
    reader.onerror = () => setError(t('图片读取失败'))
    reader.readAsDataURL(file)
  }

  const remove = async (id) => {
    if (!window.confirm(t('确定删除该发票记录吗？'))) return
    try {
      await api(`/v2/invoices/${id}`, { method: 'DELETE' })
      await load()
    } catch (err) {
      setError(t(err.message))
    }
  }

  const toggleStatus = async (row) => {
    setError('')
    const next = row.status === 'done' ? 'pending' : 'done'
    try {
      await api(`/v2/invoices/${row.id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: next }),
      })
      setSavedTip(t(next === 'done' ? '已标记为已开票 ✓' : '已恢复为待开票 ✓'))
      setTimeout(() => setSavedTip(''), 2000)
      await load()
    } catch (err) {
      setError(t(err.message))
    }
  }

  const totalCents = rows.reduce((s, r) => s + Number(r.amountCents || 0), 0)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-4">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 rounded-2xl bg-white px-3.5 py-2.5 text-sm font-medium text-slate-500 shadow-card transition hover:text-budu-600"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('返回首页')}
        </button>
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold text-slate-800">
            <Receipt className="h-5 w-5 text-budu-500" />
            {t('发票开具')}
          </h2>
          <p className="mt-0.5 text-[13px] text-slate-400">{t('登记开票信息，输入公司名称自动匹配税号')}</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className={inputCls} />
          <select value={store} onChange={(e) => setStore(e.target.value)} className={inputCls}>
            <option value="all">{t('全部门店')}</option>
            {allStores().map((s) => (
              <option key={s.key} value={s.key}>
                {s.name}
              </option>
            ))}
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={inputCls}>
            <option value="all">{t('全部状态')}</option>
            <option value="pending">{t('待开票')}</option>
            <option value="done">{t('已开票')}</option>
          </select>
          <span className="rounded-xl bg-budu-50 px-3 py-2 text-xs font-semibold text-budu-600">
            {t('合计 ¥{amount}', { amount: yuan(totalCents) })}
          </span>
        </div>
      </div>

      {savedTip && <p className="rounded-xl bg-emerald-50 px-4 py-2 text-xs font-semibold text-emerald-600">{savedTip}</p>}
      {error && <p className="rounded-xl bg-rose-50 px-4 py-2 text-xs font-medium text-rose-500">{error}</p>}

      <div className="card p-5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="flex items-center gap-2 text-[15px] font-bold text-slate-800">
            <Building2 className="h-4 w-4 text-budu-500" />
            {t('新增开票申请')}
          </h3>
          <span
            className={`rounded-lg px-2 py-0.5 text-[11px] font-bold ${
              ocrReady ? 'bg-emerald-50 text-emerald-600' : ocrReady === false ? 'bg-amber-50 text-amber-600' : 'bg-slate-100 text-slate-400'
            }`}
          >
            {t(ocrReady ? 'OCR 已启用' : ocrReady === false ? 'OCR 未配置（可手动填写）' : 'OCR 状态检测中…')}
          </span>
        </div>

        <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFile} />
        <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={handleFile} />
        <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={ocrBusy}
            className="flex w-full items-center gap-3 rounded-2xl border-2 border-dashed border-budu-200 bg-budu-50/40 px-4 py-3 text-left transition hover:border-budu-400 hover:bg-budu-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {preview ? (
              <img src={preview} alt="发票" className="h-14 w-14 rounded-xl border border-slate-100 bg-white object-contain" />
            ) : (
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-white text-budu-500 shadow-sm">
                {ocrBusy ? <Loader2 className="h-5 w-5 animate-spin" /> : <ImageUp className="h-5 w-5" />}
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-slate-700">
                {ocrBusy ? t('正在识别发票信息…') : t(preview ? '重新选择发票图片' : '从相册选择发票图片')}
              </span>
              <span className="mt-0.5 block text-[11px] text-slate-400">{t('支持拍照/相册图片，自动压缩为 JPG 识别；识别后可手动修改')}</span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => cameraInputRef.current?.click()}
            disabled={ocrBusy}
            className="flex w-full items-center justify-center gap-2 rounded-2xl border border-budu-200 bg-white px-4 py-3 text-sm font-semibold text-budu-600 transition hover:bg-budu-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Camera className="h-5 w-5" />
            {t('拍照上传')}
          </button>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <select value={form.storeKey} onChange={(e) => setField('storeKey', e.target.value)} className={inputCls}>
            {allStores().map((s) => (
              <option key={s.key} value={s.key}>
                {s.name}
              </option>
            ))}
          </select>

          <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white p-1">
            <button
              type="button"
              onClick={() => setField('titleType', 'company')}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
                form.titleType === 'company' ? 'bg-gradient-to-r from-budu-500 to-grape-500 text-white shadow' : 'text-slate-500 hover:bg-budu-50'
              }`}
            >
              <Building2 className="h-4 w-4" />
              {t('公司')}
            </button>
            <button
              type="button"
              onClick={() => setField('titleType', 'personal')}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
                form.titleType === 'personal' ? 'bg-gradient-to-r from-budu-500 to-grape-500 text-white shadow' : 'text-slate-500 hover:bg-budu-50'
              }`}
            >
              <User className="h-4 w-4" />
              {t('个人')}
            </button>
          </div>

          <input type="number" step="0.01" min="0" value={form.amount} onChange={(e) => setField('amount', e.target.value)} placeholder={t('开票金额（元）')} className={inputCls} />

          <div className="relative">
            <input
              ref={nameInputRef}
              value={form.companyName}
              onChange={(e) => changeName(e.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setTimeout(() => setFocused(false), 150)}
              placeholder={t(form.titleType === 'company' ? '公司名称（输入自动匹配税号）' : '个人姓名 / 抬头')}
              className={inputCls}
            />
            {focused && suggestions.length > 0 && (
              <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-xl border border-slate-100 bg-white p-1 shadow-xl">
                {suggestions.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pickCompany(c)}
                    className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm text-slate-600 transition hover:bg-budu-50"
                  >
                    <span className="truncate">{c.name}</span>
                    {c.taxNo && <span className="shrink-0 text-[11px] text-slate-400">{c.taxNo}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          {form.titleType === 'company' ? (
            <input value={form.taxNo} onChange={(e) => setField('taxNo', e.target.value)} placeholder={t('公司税号（自动匹配，可修改）')} className={inputCls} />
          ) : (
            <div className="hidden lg:block" />
          )}

          <input value={form.category} onChange={(e) => setField('category', e.target.value)} placeholder={t('品类（手动填写）')} className={inputCls} />

          <input type="email" value={form.email} onChange={(e) => setField('email', e.target.value)} placeholder={t('收票邮箱')} className={inputCls} />

          <button
            onClick={submit}
            className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-budu-500 to-grape-500 px-4 py-2.5 text-sm font-semibold text-white transition active:scale-95"
          >
            <Plus className="h-4 w-4" />
            {t('提交开票')}
          </button>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <h3 className="text-[15px] font-bold text-slate-800">{t('开票记录')}</h3>
          <span className="rounded-lg bg-budu-50 px-2 py-0.5 text-xs font-semibold text-budu-600">{rows.length}</span>
        </div>
        <div className="max-h-[520px] divide-y divide-slate-50 overflow-y-auto">
          {rows.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3">
              <span
                className={`rounded-lg px-2 py-0.5 text-[11px] font-bold ${
                  r.titleType === 'company' ? 'bg-budu-50 text-budu-600' : 'bg-grape-50 text-grape-600'
                }`}
              >
                {t(r.titleType === 'company' ? '公司' : '个人')}
              </span>
              <span
                className={`rounded-lg px-2 py-0.5 text-[11px] font-bold ${
                  r.status === 'done' ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'
                }`}
              >
                {t(r.status === 'done' ? '已开票' : '待开票')}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-slate-700">
                  {r.companyName || '—'}
                  {r.taxNo && <span className="ml-2 font-normal text-slate-400">{r.taxNo}</span>}
                </p>
                <p className="mt-0.5 text-[11px] text-slate-400">
                  {storeName(r.storeKey)} · {t(r.category)} · {r.email} · {fmtTime(r.createdAt)} · {r.createdBy}
                </p>
              </div>
              <span className="text-sm font-bold text-slate-800">¥{yuan(r.amountCents)}</span>
              <button
                onClick={() => toggleStatus(r)}
                className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold transition ${
                  r.status === 'done'
                    ? 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                    : 'bg-emerald-50 text-emerald-600 hover:bg-emerald-100'
                }`}
              >
                {t(r.status === 'done' ? '标记待开票' : '标记已开票')}
              </button>
              <button
                onClick={() => remove(r.id)}
                className="rounded-lg p-1.5 text-slate-300 transition hover:bg-rose-50 hover:text-rose-500"
                aria-label={t('删除')}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
          {rows.length === 0 && <p className="grid place-items-center py-10 text-xs text-slate-300">{t('本月暂无开票记录')}</p>}
        </div>
      </div>
    </div>
  )
}
