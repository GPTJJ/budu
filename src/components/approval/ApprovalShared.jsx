// 审批中心共享组件与工具（纯前端 UI，业务逻辑不变）
import { useEffect, useRef, useState } from 'react'
import { Banknote, FileSpreadsheet, FileText, Image as ImageIcon, Paperclip, Receipt, Upload, X } from 'lucide-react'
import { api } from '../../utils/api'

/** 状态元数据（保持现有状态枚举，仅 UI 展示） */
export const STATUS_META = {
  draft: { label: '草稿', cls: 'bg-slate-100 text-slate-500' },
  pending: { label: '待审批', cls: 'bg-amber-50 text-amber-600' },
  approved: { label: '已通过', cls: 'bg-emerald-50 text-emerald-600' },
  rejected: { label: '已驳回', cls: 'bg-rose-50 text-rose-600' },
  withdrawn: { label: '已撤回', cls: 'bg-slate-100 text-slate-400' },
  archived: { label: '已归档', cls: 'bg-violet-50 text-violet-600' },
}

export function StatusBadge({ status, size = 'sm' }) {
  const meta = STATUS_META[status] || { label: status, cls: 'bg-slate-100 text-slate-500' }
  return (
    <span className={`inline-flex shrink-0 items-center rounded-md font-bold ${size === 'sm' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-1 text-[11px]'} ${meta.cls}`}>
      {meta.label}
    </span>
  )
}

export const yuan = (cents) => `¥${Number(cents || 0).toFixed(2)}`
export const fmtTime = (v) => (v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '—')
export const fmtShortTime = (v) => (v ? new Date(v).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '—')

export const ACTION_LABEL = {
  create: '创建草稿',
  submit: '提交申请',
  edit: '编辑单据',
  approve: '审批通过',
  reject: '审批驳回',
  withdraw: '撤回申请',
  archive: '归档单据',
}

/** 模板前端元数据：图标/分类（一期仅两个真实模板，不虚构） */
export const TEMPLATE_META = {
  payroll: { name: '工资审批', icon: Banknote, iconCls: 'bg-emerald-50 text-emerald-600', category: 'common' },
  expense: { name: '报销审批', icon: Receipt, iconCls: 'bg-amber-50 text-amber-600', category: 'finance' },
}

export const CATEGORY_LABEL = { common: '常用', finance: '财务', personnel: '人事', other: '其他' }

export function templateName(key) {
  return TEMPLATE_META[key]?.name || key
}

export function templateIcon(key) {
  return TEMPLATE_META[key]?.icon || FileText
}

export function templateCategory(key) {
  return TEMPLATE_META[key]?.category || 'other'
}

export const MAX_ATTACH = 8 * 1024 * 1024

/** 图片压缩（最长边 2000px JPEG）——复用现有逻辑 */
export function compressImageFile(file, maxSize = 2000, quality = 0.82) {
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
        const baseName = String(file.name || 'image').replace(/\.[^.]+$/, '') || 'image'
        resolve({ dataUrl, fileName: `${baseName}.jpg`, mime: 'image/jpeg' })
      }
      img.onerror = () => reject(new Error('图片读取失败'))
      img.src = reader.result
    }
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve({ dataUrl: reader.result, fileName: file.name, mime: file.type })
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

/** Excel 在线预览（复用现有 xlsx 解析） */
export function ExcelPreview({ dataUrl }) {
  const [rows, setRows] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    import('xlsx')
      .then((XLSX) => {
        try {
          const b64 = String(dataUrl || '').split(',')[1]
          const wb = XLSX.read(b64, { type: 'base64' })
          const ws = wb.Sheets[wb.SheetNames[0]]
          const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
          setRows(data.slice(0, 50))
        } catch {
          setError('该表格暂无法预览，请下载查看')
        }
      })
      .catch(() => setError('该表格暂无法预览，请下载查看'))
  }, [dataUrl])
  if (error) return <p className="py-6 text-center text-xs text-slate-300">{error}</p>
  if (!rows) return <p className="py-6 text-center text-xs text-slate-300">预览加载中…</p>
  if (rows.length === 0) return <p className="py-6 text-center text-xs text-slate-300">表格内容为空</p>
  return (
    <div className="max-h-72 overflow-auto rounded-lg border border-slate-100">
      <table className="w-full min-w-[480px] text-left text-xs">
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className={i === 0 ? 'bg-budu-50/50 font-semibold text-slate-600' : 'border-t border-slate-50'}>
              {(Array.isArray(row) ? row : []).slice(0, 12).map((cell, j) => (
                <td key={j} className="max-w-[200px] truncate px-2.5 py-1.5">{String(cell ?? '')}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length >= 50 && <p className="border-t border-slate-50 px-3 py-2 text-[10px] text-slate-300">仅预览前 50 行，完整内容请下载查看</p>}
    </div>
  )
}

/** PDF 在线预览（blob URL，复用现有模式） */
export function PdfPreview({ dataUrl }) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    try {
      const bin = atob(String(dataUrl || '').split(',')[1] || '')
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
      const blob = new Blob([bytes], { type: 'application/pdf' })
      setUrl(URL.createObjectURL(blob))
      return () => URL.revokeObjectURL(url)
    } catch {
      setUrl('')
      return undefined
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataUrl])
  if (!url) return <p className="py-6 text-center text-xs text-slate-300">PDF 暂无法预览，请下载查看</p>
  return <iframe src={url} title="PDF 预览" className="h-72 w-full rounded-lg border border-slate-100" />
}

export function fileIcon(fileType, cls = 'h-4 w-4') {
  if (fileType.startsWith('image/')) return <ImageIcon className={`${cls} text-budu-500`} />
  if (fileType === 'application/pdf') return <FileText className={`${cls} text-rose-500`} />
  return <FileSpreadsheet className={`${cls} text-emerald-500`} />
}

/** 附件区：简洁「附件 +」入口 + 缩略信息（复用现有上传接口） */
export function AttachmentUploader({ attachments, onChange }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef(null)

  const handleFiles = async (fileList) => {
    setError('')
    for (const file of Array.from(fileList || []).slice(0, 5)) {
      if (file.size > MAX_ATTACH) {
        setError(`「${file.name}」超过 8MB，请压缩后上传`)
        continue
      }
      setBusy(true)
      try {
        const isImage = /^image\//.test(file.type)
        const { dataUrl, fileName, mime } = isImage ? await compressImageFile(file) : await readFileAsDataUrl(file)
        if (dataUrl.length > MAX_ATTACH * 1.5) {
          setError(`「${fileName}」超过 8MB，请压缩后上传`)
          continue
        }
        const res = await api('/v2/approvals/attachments', {
          method: 'POST',
          body: JSON.stringify({ name: fileName, fileType: mime, dataUrl }),
        })
        onChange([...(attachments || []), res.attachment])
      } catch (e) {
        setError(e.message || '上传失败')
      } finally {
        setBusy(false)
      }
    }
    if (inputRef.current) inputRef.current.value = ''
  }

  const remove = (id) => onChange((attachments || []).filter((a) => a.id !== id))

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {(attachments || []).map((a) => (
          <span key={a.id} className="inline-flex max-w-full items-center gap-1.5 rounded-lg bg-slate-50 px-2.5 py-1.5 text-[11px] font-semibold text-slate-600">
            {a.fileType.startsWith('image/') && a.dataUrl ? (
              <img src={a.dataUrl} alt="" className="h-5 w-5 rounded object-cover" />
            ) : (
              fileIcon(a.fileType)
            )}
            <span className="max-w-[160px] truncate">{a.name}</span>
            <button onClick={() => remove(a.id)} className="text-slate-300 transition hover:text-rose-500" aria-label="移除附件">
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        ))}
        <button
          onClick={() => inputRef.current?.click()}
          disabled={busy || (attachments || []).length >= 10}
          className="grid h-8 w-8 place-items-center rounded-lg border border-dashed border-slate-300 text-slate-400 transition hover:border-budu-400 hover:text-budu-500 disabled:opacity-40"
          aria-label="添加附件"
        >
          {busy ? <Upload className="h-4 w-4 animate-pulse" /> : <Paperclip className="h-4 w-4" />}
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="image/*,.pdf,.xls,.xlsx"
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>
      {error && <p className="mt-1.5 text-[11px] font-medium text-rose-500">{error}</p>}
    </div>
  )
}
