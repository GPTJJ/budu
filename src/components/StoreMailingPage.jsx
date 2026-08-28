import { useEffect, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import {
  ArrowLeft, CalendarDays, Check, ClipboardPaste, Copy, FileSpreadsheet, ImageUp, Loader2, Mic, PackageCheck, Plus, Send, Sparkles,
} from 'lucide-react'
import { api } from '../utils/api'
import { mergeRecipientFields, parseRecipientText } from '../utils/addressParser'
import { createOcrRequestId, fingerprintImageDataUrl, isMatchingOcrResponse, sha256Hex } from '../utils/ocrIntegrity'
import qrUrl from '../assets/mailing-qr.jpg'

const STORAGE_KEY = 'budu-store-mailing'

function loadSaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

async function copyText(text) {
  if (!text) return false
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    /* 降级方案：兼容部分 WebView / 非安全上下文 */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

function OptionGroup({ label, options, value, onChange }) {
  return (
    <div>
      <p className="mb-2 text-sm font-medium text-slate-600">{label}</p>
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
        {options.map((opt) => {
          const active = value === opt
          return (
            <button
              key={opt}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(opt)}
              className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
                active
                  ? 'bg-budu-50 text-budu-700 ring-1 ring-budu-200'
                  : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              {opt}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export default function StoreMailingPage({ onBack }) {
  const saved = loadSaved()
  const [method, setMethod] = useState(saved?.method || '顺丰邮寄')
  const [postage, setPostage] = useState(saved?.postage || '包邮')
  const [fee, setFee] = useState(saved?.fee || '标准件18¥')
  const [wechatFee, setWechatFee] = useState(saved?.wechatFee || false)
  const [address, setAddress] = useState(saved?.address || '')
  const [recipient, setRecipient] = useState(saved?.recipient || '')
  const [phone, setPhone] = useState(saved?.phone || '')
  const [remark, setRemark] = useState(saved?.remark || '')
  const formValuesRef = useRef({
    recipientName: saved?.recipient || '',
    phone: saved?.phone || '',
    address: saved?.address || '',
    note: saved?.remark || '',
  })
  const ocrOwnedFieldsRef = useRef({})
  const [copied, setCopied] = useState('')
  const [records, setRecords] = useState([])
  const [recordsLoading, setRecordsLoading] = useState(true)
  const [recordsError, setRecordsError] = useState('')
  const [activeTab, setActiveTab] = useState('pending')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [submitTip, setSubmitTip] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [shippingId, setShippingId] = useState('')
  const [exportDone, setExportDone] = useState(false)

  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ method, postage, fee, wechatFee, address, recipient, phone, remark }),
      )
    } catch {
      /* 隐私模式等场景忽略 */
    }
  }, [method, postage, fee, wechatFee, address, recipient, phone, remark])

  useEffect(() => {
    if (!copied) return undefined
    const id = setTimeout(() => setCopied(''), 1600)
    return () => clearTimeout(id)
  }, [copied])

  const handleCopy = async (key, text) => {
    const ok = await copyText(text)
    if (ok) setCopied(key)
  }

  const copyAll = async () => {
    const lines = [`收件地址：${address}`, `收件人：${recipient}`, `联系方式：${phone}`]
    if (remark) lines.push(`备注：${remark}`)
    const ok = await copyText(lines.join('\n'))
    if (ok) setCopied('all')
  }

  const loadRecords = async () => {
    try {
      setRecordsLoading(true)
      const data = await api('/v2/mailing-records')
      setRecords(Array.isArray(data.rows) ? data.rows : [])
      setRecordsError('')
    } catch (e) {
      setRecordsError(e.message || '加载发件记录失败')
    } finally {
      setRecordsLoading(false)
    }
  }

  useEffect(() => {
    loadRecords()
  }, [])

  const showTip = (text) => {
    setSubmitTip(text)
    setTimeout(() => setSubmitTip(''), 2500)
  }

  // ---------- 智能识别（粘贴 / 图片 / 语音 → 拆分姓名/电话/地址） ----------
  const [recognizeText, setRecognizeText] = useState('')
  const [recognizeBusy, setRecognizeBusy] = useState('') // '' | 'image' | 'voice'
  const [recognizeHint, setRecognizeHint] = useState('')
  const [ocrSession, setOcrSession] = useState({
    status: 'idle', generation: 0, requestId: '', fileFingerprint: '', rawTextFingerprint: '', parserInputFingerprint: '',
  })
  const fileInputRef = useRef(null)
  const recognitionRef = useRef(null)
  const ocrGenerationRef = useRef(0)
  const ocrCurrentRef = useRef(null)
  const ocrAbortRef = useRef(null)

  useEffect(() => () => {
    ocrAbortRef.current?.abort()
    recognitionRef.current?.abort?.()
  }, [])

  const commitRecipientFields = (values) => {
    formValuesRef.current = values
    setRecipient(values.recipientName)
    setPhone(values.phone)
    setAddress(values.address)
    setRemark(values.note)
  }

  const handleManualFieldChange = (field, value) => {
    delete ocrOwnedFieldsRef.current[field]
    commitRecipientFields({ ...formValuesRef.current, [field]: value })
  }

  const clearOcrOwnedFields = () => {
    const current = formValuesRef.current
    const next = { ...current }
    let changed = false
    for (const [field, ownedValue] of Object.entries(ocrOwnedFieldsRef.current)) {
      if (ownedValue && current[field] === ownedValue) {
        next[field] = ''
        changed = true
      }
    }
    ocrOwnedFieldsRef.current = {}
    if (changed) commitRecipientFields(next)
  }

  const invalidateOcrSession = ({ clearOwned = true } = {}) => {
    ocrGenerationRef.current += 1
    ocrAbortRef.current?.abort()
    ocrAbortRef.current = null
    ocrCurrentRef.current = null
    if (clearOwned) clearOcrOwnedFields()
    setOcrSession({
      status: 'idle', generation: ocrGenerationRef.current, requestId: '', fileFingerprint: '', rawTextFingerprint: '', parserInputFingerprint: '',
    })
    setRecognizeBusy((busy) => (busy === 'image' ? '' : busy))
  }

  const applyParsed = (text, source = 'text') => {
    const parsed = parseRecipientText(text)
    const { recipientName, phone: parsedPhone, address: parsedAddress, note: parsedNote, matched } = parsed
    if (!matched) {
      setRecognizeHint('未能从文本中识别出收件信息，请检查后重试或手动填写')
      return
    }
    const merged = mergeRecipientFields(
      formValuesRef.current,
      parsed,
    )
    if (source === 'image') {
      const nextOwned = {}
      for (const field of ['recipientName', 'phone', 'address', 'note']) {
        if (!String(formValuesRef.current[field] || '').trim() && parsed[field]) nextOwned[field] = merged[field]
      }
      ocrOwnedFieldsRef.current = nextOwned
    }
    commitRecipientFields(merged)
    const parts = []
    if (recipientName) parts.push('姓名')
    if (parsedPhone) parts.push('电话')
    if (parsedAddress) parts.push('地址')
    if (parsedNote) parts.push('备注')
    setRecognizeHint(`已识别${parts.join('、')}（仅填充空字段）`)
    setRecognizeText('')
    return parsed
  }

  const handlePasteRecognize = () => {
    const text = recognizeText.trim()
    if (!text) {
      setRecognizeHint('请先粘贴或输入收件文本')
      return
    }
    invalidateOcrSession()
    applyParsed(text)
  }

  const handleImageFile = async (file) => {
    if (!file) return
    const generation = ocrGenerationRef.current + 1
    ocrGenerationRef.current = generation
    ocrAbortRef.current?.abort()
    ocrAbortRef.current = null
    ocrCurrentRef.current = { generation, requestId: '', fileFingerprint: '' }
    clearOcrOwnedFields()
    setRecognizeBusy('image')
    setRecognizeHint('')
    setOcrSession({
      status: 'loading', generation, requestId: '', fileFingerprint: '', rawTextFingerprint: '', parserInputFingerprint: '',
    })
    let requestTimeoutId
    let requestTimedOut = false
    try {
      // 图片压缩到 1600px 内、JPEG 质量 0.85，控制上传体积
      const compressed = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          const img = new Image()
          img.onload = () => {
            const MAX = 1600
            const scale = Math.min(1, MAX / Math.max(img.width, img.height))
            const canvas = document.createElement('canvas')
            canvas.width = Math.round(img.width * scale)
            canvas.height = Math.round(img.height * scale)
            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
            resolve(canvas.toDataURL('image/jpeg', 0.85))
          }
          img.onerror = () => reject(new Error('图片读取失败'))
          img.src = String(reader.result)
        }
        reader.onerror = () => reject(new Error('图片读取失败'))
        reader.readAsDataURL(file)
      })
      if (ocrCurrentRef.current?.generation !== generation) return
      const fileFingerprint = await fingerprintImageDataUrl(compressed)
      if (ocrCurrentRef.current?.generation !== generation) return
      const requestId = createOcrRequestId(generation, fileFingerprint)
      const context = { generation, requestId, fileFingerprint }
      const controller = new AbortController()
      ocrCurrentRef.current = context
      ocrAbortRef.current = controller
      requestTimeoutId = setTimeout(() => {
        requestTimedOut = true
        controller.abort()
      }, 30000)
      setOcrSession({
        status: 'loading', ...context, rawTextFingerprint: '', parserInputFingerprint: '',
      })
      const data = await api('/v2/ocr/general', {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({ imageBase64: compressed, requestId, fileFingerprint }),
      })
      const currentMatches = ocrCurrentRef.current?.generation === context.generation
        && ocrCurrentRef.current?.requestId === context.requestId
        && ocrCurrentRef.current?.fileFingerprint === context.fileFingerprint
      if (!currentMatches) return
      if (!isMatchingOcrResponse(ocrCurrentRef.current, context, data)) {
        throw new Error('OCR 响应与当前图片不匹配，请重新选择图片')
      }
      const text = String(data.text || '').trim()
      if (!text) {
        setRecognizeHint('未识别到有效信息，请确认照片文字清晰完整')
        setOcrSession({
          status: 'error', ...context, rawTextFingerprint: '', parserInputFingerprint: '',
        })
        return
      }
      const rawTextFingerprint = await sha256Hex(text)
      const parserInputFingerprint = await sha256Hex(text)
      if (!isMatchingOcrResponse(ocrCurrentRef.current, context, data)) return
      const parsed = applyParsed(text, 'image')
      setOcrSession({
        status: parsed?.matched ? 'success' : 'error',
        ...context,
        rawTextFingerprint,
        parserInputFingerprint,
      })
    } catch (e) {
      if (ocrCurrentRef.current?.generation !== generation || (e?.name === 'AbortError' && !requestTimedOut)) return
      const detail = requestTimedOut ? '识别请求超时，请重试' : (e.message || '请重新选择图片后重试')
      setRecognizeHint(`图片识别失败：${detail}`)
      setOcrSession((session) => ({ ...session, status: 'error' }))
    } finally {
      clearTimeout(requestTimeoutId)
      if (ocrCurrentRef.current?.generation === generation) {
        setRecognizeBusy('')
        ocrAbortRef.current = null
      }
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleVoiceRecognize = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) {
      setRecognizeHint('当前浏览器不支持语音识别（请使用 iPhone Safari / 微信内置浏览器）')
      return
    }
    try {
      invalidateOcrSession()
      const rec = new SR()
      recognitionRef.current = rec
      rec.lang = 'zh-CN'
      rec.interimResults = false
      rec.maxAlternatives = 1
      setRecognizeBusy('voice')
      setRecognizeHint('正在聆听…请说出收件人、电话和地址')
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

  const handleSubmit = async () => {
    if (!address.trim() || !recipient.trim() || !phone.trim()) {
      showTip('请先填写收件地址、收件人、联系方式')
      return
    }
    setSubmitting(true)
    try {
      await api('/v2/mailing-records', {
        method: 'POST',
        body: JSON.stringify({ method, postage, fee, address, recipient, phone, remark }),
      })
      // 提交成功后清空表单与本地存档，避免下次打开时残留上次信息
      setMethod('顺丰邮寄')
      setPostage('包邮')
      setFee('标准件18¥')
      setWechatFee(false)
      setAddress('')
      setRecipient('')
      setPhone('')
      setRemark('')
      formValuesRef.current = { recipientName: '', phone: '', address: '', note: '' }
      ocrOwnedFieldsRef.current = {}
      try {
        localStorage.removeItem(STORAGE_KEY)
      } catch {
        /* 隐私模式等场景忽略 */
      }
      showTip('已提交发件单，表单已清空 ✓')
      await loadRecords()
    } catch (e) {
      showTip(e.message || '提交失败')
    } finally {
      setSubmitting(false)
    }
  }

  const markShipped = async (id) => {
    setShippingId(id)
    try {
      await api(`/v2/mailing-records/${id}/ship`, { method: 'POST' })
      await loadRecords()
    } catch (e) {
      showTip(e.message || '操作失败')
    } finally {
      setShippingId('')
    }
  }

  const inRange = (iso) => {
    if (!fromDate && !toDate) return true
    const d = iso ? iso.slice(0, 10) : ''
    if (fromDate && d < fromDate) return false
    if (toDate && d > toDate) return false
    return true
  }

  const pendingRecords = records.filter((r) => r.status === 'pending' && inRange(r.createdAt))
  const shippedRecords = records.filter((r) => r.status === 'shipped' && inRange(r.createdAt))
  const visibleRecords = activeTab === 'pending' ? pendingRecords : shippedRecords

  const fmtTime = (iso) => {
    if (!iso) return ''
    const d = new Date(iso)
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }

  const handleExport = () => {
    if (visibleRecords.length === 0) {
      showTip('当前筛选范围内暂无记录')
      return
    }
    const header = ['提交时间', '状态', '邮寄方式', '运费', '运费选项', '收件地址', '收件人', '联系方式', '备注']
    const body = visibleRecords.map((r) => [
      fmtTime(r.createdAt),
      r.status === 'shipped' ? '已发货' : '待发货',
      r.method,
      r.postage,
      r.fee || '',
      r.address,
      r.recipient,
      r.phone,
      r.remark || '',
    ])
    const ws = XLSX.utils.aoa_to_sheet([header, ...body])
    ws['!cols'] = [{ wch: 18 }, { wch: 8 }, { wch: 10 }, { wch: 8 }, { wch: 12 }, { wch: 30 }, { wch: 10 }, { wch: 14 }, { wch: 24 }]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, '发件记录')
    const f = `${(fromDate || 'all').replace(/-/g, '')}-${(toDate || 'all').replace(/-/g, '')}`
    XLSX.writeFile(wb, `budu发件记录_${f}.xlsx`)
    setExportDone(true)
    setTimeout(() => setExportDone(false), 2000)
  }

  const tabCls = (tab) =>
    `rounded-lg px-3 py-1.5 transition ${
      activeTab === tab ? 'bg-white text-budu-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'
    }`

  const fieldCls = 'input'

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBack}
          className="btn-secondary px-3 py-2"
        >
          <ArrowLeft className="h-4 w-4" />
          返回
        </button>
        <p className="text-sm text-slate-400">填写内容自动保存在本机，便于下次直接复制</p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_auto]">
      <div className="card p-5 sm:p-6">
        <div className="space-y-6">
          <OptionGroup label="邮寄方式" options={['顺丰邮寄', '同城闪送']} value={method} onChange={setMethod} />
          <OptionGroup label="运费" options={['包邮', '不包邮']} value={postage} onChange={setPostage} />
          {method === '顺丰邮寄' && postage === '不包邮' && (
            <OptionGroup label="运费选项" options={['标准件18¥', '生鲜航运30¥']} value={fee} onChange={setFee} />
          )}
          {method === '同城闪送' && postage === '不包邮' && (
            <div>
              <p className="mb-2 text-sm font-medium text-slate-600">费用</p>
              <button
                type="button"
                onClick={() => setWechatFee((v) => !v)}
                aria-pressed={wechatFee}
                className={`flex w-full items-center justify-between gap-2 rounded-xl border px-4 py-3 text-sm font-medium transition ${
                  wechatFee
                    ? 'border-budu-200 bg-budu-50 text-budu-700'
                    : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                <span>添加微信支付费用</span>
                {wechatFee ? <Check className="h-4 w-4 text-budu-600" /> : <Plus className="h-4 w-4 text-slate-400" />}
              </button>
            </div>
          )}

          {/* 智能识别：粘贴/图片/语音 → 拆分姓名电话地址 */}
          <div className="space-y-3 rounded-2xl border border-budu-100 bg-budu-50/40 p-4">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Sparkles className="h-4 w-4 text-budu-600" />
              <p className="text-sm font-bold text-slate-700">智能识别收件信息</p>
              <span className="w-full text-[11px] text-slate-400 sm:w-auto">粘贴或说出「姓名+电话+地址+备注」，自动拆分填入</span>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <textarea
                value={recognizeText}
                onChange={(e) => setRecognizeText(e.target.value)}
                placeholder="「粘贴识别」或输入文本，智能拆分姓名、电话和地址"
                rows={3}
                className={`${fieldCls} min-h-[84px] min-w-0 flex-1 resize-y sm:min-h-[72px]`}
              />
              <button
                type="button"
                onClick={handlePasteRecognize}
                disabled={recognizeBusy === 'voice'}
                className="btn-primary h-11 shrink-0 whitespace-nowrap px-3 sm:h-10"
              >
                <ClipboardPaste className="h-4 w-4" />
                粘贴并识别
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={recognizeBusy === 'voice'}
                className="btn-secondary h-9 px-3"
              >
                {recognizeBusy === 'image' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImageUp className="h-4 w-4" />}
                {recognizeBusy === 'image' ? '识别中…可更换图片' : '图片识别'}
              </button>
              <button
                type="button"
                onClick={handleVoiceRecognize}
                disabled={recognizeBusy === 'voice'}
                className="btn-secondary h-9 px-3"
              >
                {recognizeBusy === 'voice' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mic className="h-4 w-4" />}
                {recognizeBusy === 'voice' ? '聆听中…' : '语音识别'}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  e.target.value = ''
                  handleImageFile(file)
                }}
              />
              <div
                data-testid="ocr-session-status"
                data-status={ocrSession.status}
                data-generation={ocrSession.generation}
                data-request-id={ocrSession.requestId}
                data-file-fingerprint={ocrSession.fileFingerprint.slice(0, 12)}
                data-raw-text-fingerprint={ocrSession.rawTextFingerprint.slice(0, 12)}
                data-parser-input-fingerprint={ocrSession.parserInputFingerprint.slice(0, 12)}
                className="w-full min-w-0"
              >
                {recognizeHint && <p className="break-words text-xs font-medium text-budu-600">{recognizeHint}</p>}
              </div>
            </div>
          </div>

          <div className="space-y-4 border-t border-slate-100 pt-5">
            <p className="text-sm font-medium text-slate-600">收件信息</p>

            <div>
              <label className="mb-1.5 block text-[13px] font-medium text-slate-500">收件地址</label>
              <div className="flex gap-2">
                <textarea
                  value={address}
                  onChange={(e) => handleManualFieldChange('address', e.target.value)}
                  placeholder="请输入收件地址"
                  rows={2}
                  className={`${fieldCls} min-h-[72px] resize-none`}
                />
                <button
                  type="button"
                  onClick={() => handleCopy('address', address)}
                  className="btn-secondary h-11 w-11 shrink-0 p-0 sm:h-10 sm:w-10"
                  aria-label="复制收件地址"
                >
                  {copied === 'address' ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-[13px] font-medium text-slate-500">收件人</label>
              <div className="flex gap-2">
                <input
                  value={recipient}
                  onChange={(e) => handleManualFieldChange('recipientName', e.target.value)}
                  placeholder="请输入收件人姓名"
                  className={fieldCls}
                />
                <button
                  type="button"
                  onClick={() => handleCopy('recipient', recipient)}
                  className="btn-secondary h-11 w-11 shrink-0 p-0 sm:h-10 sm:w-10"
                  aria-label="复制收件人"
                >
                  {copied === 'recipient' ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-[13px] font-medium text-slate-500">联系方式</label>
              <div className="flex gap-2">
                <input
                  value={phone}
                  onChange={(e) => handleManualFieldChange('phone', e.target.value)}
                  placeholder="请输入手机号 / 电话"
                  inputMode="tel"
                  className={fieldCls}
                />
                <button
                  type="button"
                  onClick={() => handleCopy('phone', phone)}
                  className="btn-secondary h-11 w-11 shrink-0 p-0 sm:h-10 sm:w-10"
                  aria-label="复制联系方式"
                >
                  {copied === 'phone' ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-[13px] font-medium text-slate-500">备注</label>
              <div className="flex gap-2">
                <textarea
                  value={remark}
                  onChange={(e) => handleManualFieldChange('note', e.target.value)}
                  placeholder="商品信息及数量，顾客指定时间"
                  rows={2}
                  className={`${fieldCls} min-h-[56px] resize-none`}
                />
                <button
                  type="button"
                  onClick={() => handleCopy('remark', remark)}
                  className="btn-secondary h-11 w-11 shrink-0 p-0 sm:h-10 sm:w-10"
                  aria-label="复制备注"
                >
                  {copied === 'remark' ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
                </button>
              </div>
            </div>
          </div>

          <button type="button" onClick={copyAll} className="btn-primary w-full py-2.5">
            {copied === 'all' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {copied === 'all' ? '已复制全部收件信息' : '一键复制全部收件信息'}
          </button>
          <button type="button" onClick={handleSubmit} disabled={submitting} className="btn-primary w-full py-2.5">
            <Send className="h-4 w-4" />
            {submitting ? '提交中…' : '提交'}
          </button>
          {submitTip && (
            <p
              className={`text-center text-xs font-medium ${
                submitTip.includes('请先') || submitTip.includes('失败') || submitTip.includes('操作') || submitTip.includes('暂无')
                  ? 'text-rose-500'
                  : 'text-emerald-600'
              }`}
            >
              {submitTip}
            </p>
          )}
        </div>
      </div>
        <aside className="card h-fit p-5 text-center lg:w-64">
          <p className="text-sm font-semibold text-slate-700">门店二维码</p>
          <img src={qrUrl} alt="门店二维码" className="mx-auto mt-3 w-48 rounded-xl sm:w-56" />
          <p className="mt-2 text-xs text-slate-400">扫码</p>
        </aside>
      </div>

      {/* 发件记录 */}
      <div className="card overflow-hidden">
        <div data-testid="mailing-record-toolbar" className="flex flex-col gap-3 border-b border-slate-100 px-4 py-4 sm:px-5 lg:flex-row lg:items-center">
          <div className="flex items-center justify-between gap-3 lg:justify-start">
            <h3 className="text-[15px] font-semibold text-slate-900">发件记录</h3>
            <span className="shrink-0 rounded-lg bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700">
              待发货 {pendingRecords.length} 条
            </span>
          </div>
          <div className="grid min-w-0 grid-cols-2 gap-2 lg:ml-auto lg:flex lg:w-auto lg:items-end">
            <div className="col-span-2 grid grid-cols-2 rounded-lg bg-slate-100 p-1 text-xs font-medium lg:inline-flex">
              <button type="button" onClick={() => setActiveTab('pending')} className={tabCls('pending')}>
                待发货（{pendingRecords.length}）
              </button>
              <button type="button" onClick={() => setActiveTab('shipped')} className={tabCls('shipped')}>
                已发货（{shippedRecords.length}）
              </button>
            </div>
            <label className="min-w-0 text-[11px] font-medium text-slate-500">
              <span className="mb-1 flex items-center gap-1"><CalendarDays className="h-3.5 w-3.5" />开始日期</span>
              <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="input min-w-0 w-full text-xs" aria-label="开始日期" />
            </label>
            <label className="min-w-0 text-[11px] font-medium text-slate-500">
              <span className="mb-1 flex items-center gap-1"><CalendarDays className="h-3.5 w-3.5" />结束日期</span>
              <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="input min-w-0 w-full text-xs" aria-label="结束日期" />
            </label>
            <button type="button" onClick={handleExport} disabled={visibleRecords.length === 0} className="btn-secondary col-span-2 min-h-11 w-full whitespace-nowrap px-3 py-2 lg:w-auto">
              {exportDone ? <Check className="h-4 w-4 text-emerald-600" /> : <FileSpreadsheet className="h-4 w-4" />}
              {exportDone ? '已导出' : '导出 Excel'}
            </button>
          </div>
        </div>
        <div className="max-h-[480px] overflow-y-auto">
          {recordsLoading ? (
            <div className="empty-state py-12">加载中…</div>
          ) : recordsError ? (
            <div className="empty-state py-12">{recordsError}</div>
          ) : visibleRecords.length === 0 ? (
            <div className="empty-state py-12">{activeTab === 'pending' ? '暂无待发货记录' : '暂无已发货记录'}</div>
          ) : (
            visibleRecords.map((r) => (
              <div key={r.id} className="flex flex-col gap-2 border-b border-slate-50 px-5 py-3 sm:flex-row sm:items-center sm:gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-semibold text-slate-700">{r.recipient}</span>
                    <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">
                      {r.method} · {r.postage}
                      {r.fee ? ` · ${r.fee}` : ''}
                    </span>
                    <span
                      className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold ${
                        r.status === 'shipped' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
                      }`}
                    >
                      {r.status === 'shipped' ? '已发货' : '待发货'}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-xs text-slate-500">{r.address}</p>
                  <p className="mt-0.5 text-[11px] text-slate-400">
                    {r.phone}
                    {r.remark ? ` · ${r.remark}` : ''} · 提交于 {fmtTime(r.createdAt)}
                  </p>
                </div>
                {r.status === 'pending' ? (
                  <button
                    type="button"
                    onClick={() => markShipped(r.id)}
                    disabled={shippingId === r.id}
                    className="btn-primary shrink-0 px-3 py-2 text-xs"
                  >
                    <PackageCheck className="h-4 w-4" />
                    {shippingId === r.id ? '处理中…' : '已发货'}
                  </button>
                ) : (
                  <span className="shrink-0 text-[11px] text-slate-300">发货于 {fmtTime(r.shippedAt)}</span>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
