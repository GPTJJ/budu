import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Building2, CalendarClock, Camera, ClipboardPaste, Copy, ImageUp, Loader2, Mail, MapPin, Mic, Plus, Receipt, Sparkles, Trash2, User } from 'lucide-react'
import { allStores, storeName } from '../utils/selectors'
import { api } from '../utils/api'
import { t } from '../utils/text'
import { normalizeImage } from '../utils/image'
import { parseInvoiceText } from '../utils/invoiceParser'

const inputCls = 'input'

const yuan = (cents) => (Number(cents || 0) / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtTime = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
}

export default function InvoicePage({ currentUser, onBack }) {
  const [month, setMonth] = useState(`${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`)
  const [store, setStore] = useState('all')
  const [tab, setTab] = useState('pending')
  const [dateFilter, setDateFilter] = useState('')
  const [pendingRows, setPendingRows] = useState([])
  const [doneRows, setDoneRows] = useState([])
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
    const base = new URLSearchParams({ month })
    if (store !== 'all') base.set('store', store)
    const pendingQs = new URLSearchParams(base)
    pendingQs.set('status', 'pending')
    const doneQs = new URLSearchParams(base)
    doneQs.set('status', 'done')
    if (dateFilter) doneQs.set('date', dateFilter)
    try {
      const [pd, dn, cps] = await Promise.all([
        api(`/v2/invoices?${pendingQs}`),
        api(`/v2/invoices?${doneQs}`),
        api('/v2/invoices/companies'),
      ])
      setPendingRows(pd.rows || [])
      setDoneRows(dn.rows || [])
      setCompanies(cps.rows || [])
    } catch (err) {
      setError(t(err.message))
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, store, dateFilter])

  const rows = useMemo(() => {
    if (tab === 'done') {
      return [...doneRows].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    }
    return pendingRows
  }, [tab, pendingRows, doneRows])

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

  // ---------- 智能识别（粘贴 / 语音 → 拆分抬头/税号/金额） ----------
  const [recognizeText, setRecognizeText] = useState('')
  const [recognizeBusy, setRecognizeBusy] = useState('') // '' | 'voice'
  const [recognizeHint, setRecognizeHint] = useState('')
  const recognitionRef = useRef(null)

  const applyParsed = (text) => {
    const { companyName, taxNo, amount, email, titleType, matched } = parseInvoiceText(text)
    if (!matched) {
      setRecognizeHint('未能从文本中识别出开票信息，请检查后重试或手动填写')
      return
    }
    if (companyName) {
      setField('companyName', companyName)
      // 与字典精确匹配时自动补税号
      const hit = companies.find((c) => c.name.toLowerCase() === companyName.toLowerCase())
      setField('taxNo', hit ? hit.taxNo || '' : taxNo || '')
      if (titleType) setField('titleType', titleType)
    } else if (taxNo) {
      setField('taxNo', taxNo)
    }
    if (amount) setField('amount', amount)
    if (email) setField('email', email)
    const parts = []
    if (companyName) parts.push(`抬头「${companyName}」`)
    if (taxNo) parts.push(`税号「${taxNo}」`)
    if (amount) parts.push(`金额「${amount}」`)
    setRecognizeHint(`已识别${parts.join('、')}（空字段已自动填入）`)
    setRecognizeText('')
  }

  const handlePasteRecognize = () => {
    const text = recognizeText.trim()
    if (!text) {
      setRecognizeHint('请先粘贴或输入开票文本')
      return
    }
    applyParsed(text)
  }

  const handleVoiceRecognize = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) {
      setRecognizeHint('当前浏览器不支持语音识别（请使用 iPhone Safari / 微信内置浏览器）')
      return
    }
    try {
      const rec = new SR()
      recognitionRef.current = rec
      rec.lang = 'zh-CN'
      rec.interimResults = false
      rec.maxAlternatives = 1
      setRecognizeBusy('voice')
      setRecognizeHint('正在聆听…请说出抬头、税号和金额')
      rec.onresult = (event) => {
        const transcript = Array.from(event.results)
          .map((r) => r[0].transcript)
          .join('')
        setRecognizeBusy('')
        if (transcript.trim()) applyParsed(transcript)
        else setRecognizeHint('没有听清，请重试')
      }
      rec.onerror = (event) => {
        setRecognizeBusy('')
        const msg = {
          'not-allowed': '麦克风权限被拒绝，请在系统设置中允许访问麦克风',
          'service-not-allowed': '语音服务不可用',
          'no-speech': '没有检测到语音，请重试',
          network: '网络异常，语音识别失败',
        }[event.error]
        setRecognizeHint(msg || `语音识别失败（${event.error}）`)
      }
      rec.onend = () => {
        recognitionRef.current = null
        setRecognizeBusy((busy) => (busy === 'voice' ? '' : busy))
      }
      rec.start()
    } catch {
      setRecognizeBusy('')
      setRecognizeHint('语音识别启动失败，请重试')
    }
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
        const dataUrl = await normalizeImage(original, file.type)
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

  const copyRow = async (r) => {
    const text = [
      `${t('抬头')}：${r.companyName || '—'}`,
      `${t('税号')}：${r.taxNo || '—'}`,
      `${t('邮箱')}：${r.email || '—'}`,
      `${t('金额')}：¥${yuan(r.amountCents)}`,
      `${t('品类')}：${r.category || t('其他')}`,
      `${t('门店')}：${storeName(r.storeKey)}`,
      `${t('时间')}：${fmtTime(r.createdAt)}`,
    ].join('\n')
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    setSavedTip(t('已复制抬头/税号/邮箱等信息 ✓'))
    setTimeout(() => setSavedTip(''), 2000)
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
          {tab === 'done' && (
            <input type="date" value={dateFilter} onChange={(e) => setDateFilter(e.target.value)} className={inputCls} />
          )}
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

        {/* 智能识别：粘贴/语音 → 拆分抬头/税号/金额 */}
        <div className="mt-3 space-y-3 rounded-2xl border border-budu-100 bg-budu-50/40 p-4">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-budu-600" />
            <p className="text-sm font-bold text-slate-700">智能识别开票信息</p>
            <span className="text-[11px] text-slate-400">粘贴或说出「抬头+税号+金额」，自动拆分填入</span>
          </div>
          <div className="flex gap-2">
            <input
              value={recognizeText}
              onChange={(e) => setRecognizeText(e.target.value)}
              placeholder="「粘贴识别」或输入文本，智能拆分抬头、税号和金额"
              className={`${inputCls} flex-1`}
            />
            <button
              type="button"
              onClick={handlePasteRecognize}
              disabled={recognizeBusy !== ''}
              className="btn-primary h-10 shrink-0 px-3"
            >
              <ClipboardPaste className="h-4 w-4" />
              粘贴并识别
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleVoiceRecognize}
              disabled={recognizeBusy !== ''}
              className="btn-secondary h-9 px-3"
            >
              {recognizeBusy === 'voice' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mic className="h-4 w-4" />}
              {recognizeBusy === 'voice' ? '聆听中…' : '语音识别'}
            </button>
            {recognizeHint && (
              <p className="w-full text-xs font-medium text-budu-600">{recognizeHint}</p>
            )}
          </div>
        </div>

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
                {ocrBusy ? t('正在识别照片文字…') : t(preview ? '重新选择图片' : '从相册选择图片/发票照片')}
              </span>
              <span className="mt-0.5 block text-[11px] text-slate-400">{t('支持发票/收据/对账单等照片，自动匹配抬头税号金额')}</span>
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
                form.titleType === 'company' ? 'bg-budu-500 text-white shadow' : 'text-slate-500 hover:bg-budu-50'
              }`}
            >
              <Building2 className="h-4 w-4" />
              {t('公司')}
            </button>
            <button
              type="button"
              onClick={() => setField('titleType', 'personal')}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
                form.titleType === 'personal' ? 'bg-budu-500 text-white shadow' : 'text-slate-500 hover:bg-budu-50'
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
            className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-budu-500 px-4 py-2.5 text-sm font-semibold text-white transition active:scale-95"
          >
            <Plus className="h-4 w-4" />
            {t('提交开票')}
          </button>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-4">
          <h3 className="text-[15px] font-bold text-slate-800">{t('开票记录')}</h3>
          <div className="flex items-center gap-1 rounded-xl bg-slate-100 p-1">
            <button
              type="button"
              onClick={() => setTab('pending')}
              className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${
                tab === 'pending' ? 'bg-white text-budu-600 shadow' : 'text-slate-400 hover:text-slate-600'
              }`}
            >
              {t('待开票')}
              <span className="ml-1 text-[10px] opacity-70">{pendingRows.length}</span>
            </button>
            <button
              type="button"
              onClick={() => setTab('done')}
              className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${
                tab === 'done' ? 'bg-white text-emerald-600 shadow' : 'text-slate-400 hover:text-slate-600'
              }`}
            >
              {t('已开票')}
              <span className="ml-1 text-[10px] opacity-70">{doneRows.length}</span>
            </button>
          </div>
        </div>
        <div className="space-y-3 p-3 sm:max-h-[520px] sm:space-y-0 sm:divide-y sm:divide-slate-50 sm:overflow-y-auto sm:p-0">
          {rows.map((r) => (
            <div
              key={r.id}
              role={tab === 'pending' ? 'button' : undefined}
              tabIndex={tab === 'pending' ? 0 : undefined}
              onClick={tab === 'pending' ? () => copyRow(r) : undefined}
              onKeyDown={tab === 'pending' ? (e) => e.key === 'Enter' && copyRow(r) : undefined}
              className={`rounded-2xl border border-slate-100 bg-white p-4 shadow-sm sm:flex sm:flex-wrap sm:items-center sm:gap-x-4 sm:gap-y-1 sm:rounded-none sm:border-0 sm:bg-transparent sm:px-5 sm:py-3 sm:shadow-none ${
                tab === 'pending' ? 'cursor-pointer transition hover:border-budu-100 hover:bg-slate-50' : ''
              }`}
              title={tab === 'pending' ? t('点击复制抬头/税号/邮箱等信息') : undefined}
            >
              <div className="flex items-center gap-2 sm:contents">
                <span className="shrink-0 rounded-lg bg-budu-50 px-2 py-0.5 text-[11px] font-bold text-budu-600">
                  {t(r.titleType === 'company' ? '公司' : '个人')}
                </span>
                <span
                  className={`shrink-0 rounded-lg px-2 py-0.5 text-[11px] font-bold ${
                    r.status === 'done' ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'
                  }`}
                >
                  {t(r.status === 'done' ? '已开票' : '待开票')}
                </span>
                <span className="ml-auto shrink-0 text-lg font-black tabular-nums text-slate-800 sm:hidden">¥{yuan(r.amountCents)}</span>
              </div>

              <div className="mt-3 min-w-0 flex-1 sm:mt-0">
                <p className="break-words text-[15px] font-bold leading-6 text-slate-800 [overflow-wrap:anywhere] sm:text-sm sm:font-semibold sm:text-slate-700">
                  {r.companyName || '—'}
                  {r.taxNo && <span className="ml-2 hidden font-normal text-slate-400 sm:inline">{r.taxNo}</span>}
                </p>
                {r.taxNo && <p className="mt-1 break-all font-mono text-xs leading-5 text-slate-400 sm:hidden">{r.taxNo}</p>}

                <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 rounded-xl bg-slate-50/80 p-3 text-xs text-slate-500 sm:hidden">
                  <p className="flex min-w-0 items-center gap-1.5"><MapPin className="h-3.5 w-3.5 shrink-0 text-slate-300" /><span className="truncate">{storeName(r.storeKey)}</span></p>
                  <p className="truncate text-right">{t(r.category)}</p>
                  <p className="col-span-2 flex min-w-0 items-start gap-1.5"><Mail className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-300" /><span className="min-w-0 break-all">{r.email || '—'}</span></p>
                  <p className="col-span-2 flex min-w-0 items-center gap-1.5"><CalendarClock className="h-3.5 w-3.5 shrink-0 text-slate-300" /><span>{fmtTime(r.createdAt)}</span><span className="ml-auto shrink-0 text-slate-400">{r.createdBy}</span></p>
                </div>

                <p className="mt-0.5 hidden text-[11px] text-slate-400 sm:block">
                  {storeName(r.storeKey)} · {t(r.category)} · {r.email} · {fmtTime(r.createdAt)} · {r.createdBy}
                </p>
              </div>
              <span className="hidden shrink-0 text-sm font-bold tabular-nums text-slate-800 sm:block">¥{yuan(r.amountCents)}</span>

              <div className="mt-3 flex items-stretch gap-2 sm:mt-0 sm:items-center">
                {tab === 'pending' && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      copyRow(r)
                    }}
                    className="flex min-h-10 flex-1 items-center justify-center gap-1 rounded-xl bg-budu-50 px-3 py-2 text-xs font-semibold text-budu-600 transition hover:bg-budu-100 sm:min-h-0 sm:flex-none sm:rounded-lg sm:px-2.5 sm:py-1.5"
                    aria-label={t('复制信息')}
                  >
                    <Copy className="h-3.5 w-3.5" />
                    {t('复制信息')}
                  </button>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleStatus(r)
                  }}
                  className={`min-h-10 flex-1 rounded-xl px-3 py-2 text-xs font-semibold transition sm:min-h-0 sm:flex-none sm:rounded-lg sm:px-2.5 sm:py-1.5 ${
                    r.status === 'done'
                      ? 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                      : 'bg-emerald-50 text-emerald-600 hover:bg-emerald-100'
                  }`}
                >
                  {t(r.status === 'done' ? '标记待开票' : '标记已开票')}
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    remove(r.id)
                  }}
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-slate-100 text-slate-300 transition hover:border-rose-100 hover:bg-rose-50 hover:text-rose-500 sm:h-auto sm:w-auto sm:border-0 sm:p-1.5"
                  aria-label={t('删除')}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
          {rows.length === 0 && (
            <p className="grid place-items-center py-10 text-xs text-slate-300 sm:mx-0">
              {t(tab === 'done' ? '暂无已开票记录' : '暂无待开票记录')}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
