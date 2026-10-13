import { useEffect, useState } from 'react'
import { inspectAttachmentBytes } from '../../shared/attachmentSafety.js'
import SafePdfViewer from './SafePdfViewer.jsx'

export default function SafeAttachmentPreview({ dataUrl, name = '附件', downloadUrl }) {
  const [attachment, setAttachment] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    let imageUrl
    setAttachment(null); setError('')
    ;(async () => {
      const response = await fetch(dataUrl, { signal: controller.signal })
      if (!response.ok) throw new Error('Attachment unavailable')
      const bytes = new Uint8Array(await response.arrayBuffer())
      const safe = inspectAttachmentBytes(bytes)
      if (controller.signal.aborted) return
      if (safe.previewKind === 'image') imageUrl = URL.createObjectURL(new Blob([bytes], { type: safe.mimeType }))
      setAttachment({ ...safe, bytes, imageUrl })
    })().catch(() => { if (!controller.signal.aborted) setError('附件无法预览，请下载后查看') })
    return () => { controller.abort(); if (imageUrl) URL.revokeObjectURL(imageUrl) }
  }, [dataUrl])
  const kind = attachment?.previewKind || (error ? 'download' : 'loading')
  return <div className="w-full min-w-0" data-testid="safe-attachment-preview" data-preview-kind={kind}>
    {kind === 'loading' && <p className="p-6 text-center text-sm text-slate-400">加载中…</p>}
    {kind === 'image' && <img src={attachment.imageUrl} alt={name} className="mx-auto max-h-[60vh] max-w-full rounded-lg object-contain" />}
    {kind === 'pdf' && <SafePdfViewer bytes={attachment.bytes} dataUrl={dataUrl} downloadUrl={downloadUrl} name={name} />}
    {kind === 'download' && <p className="p-6 text-center text-sm text-slate-500">{error || '该文件仅支持下载查看，不会在页面中打开活动内容'}</p>}
  </div>
}
