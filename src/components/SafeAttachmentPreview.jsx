import { useEffect, useRef, useState } from 'react'
import { inspectAttachmentBytes } from '../../shared/attachmentSafety.js'

export default function SafeAttachmentPreview({ dataUrl, name = '附件' }) {
  const canvas = useRef(null)
  const [kind, setKind] = useState('loading')
  const [imageUrl, setImageUrl] = useState('')
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(0)
  const [error, setError] = useState('')
  useEffect(() => { setPage(1) }, [dataUrl])
  useEffect(() => {
    let active = true, task, renderTask, url
    setError(''); setKind('loading')
    if (canvas.current) delete canvas.current.dataset.rendered
    ;(async () => {
      const response = await fetch(dataUrl)
      const bytes = new Uint8Array(await response.arrayBuffer())
      const safe = inspectAttachmentBytes(bytes)
      if (!active) return
      setKind(safe.previewKind)
      if (safe.previewKind === 'image') {
        url = URL.createObjectURL(new Blob([bytes], { type: safe.mimeType }))
        setImageUrl(url)
        return
      }
      if (safe.previewKind !== 'pdf') return
      // Rendering only: no document navigation, JS actions, annotation HTML or attachment links.
      const [{ getDocument, GlobalWorkerOptions }, { default: workerUrl }] = await Promise.all([
        import('pdfjs-dist/legacy/build/pdf.mjs'), import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
      ])
      if (!active) return
      GlobalWorkerOptions.workerSrc = workerUrl
      task = getDocument({ data: bytes, useWorkerFetch: false, useWasm: false, disableAutoFetch: true, disableStream: true, useSystemFonts: true })
      const pdf = await task.promise
      if (!active) return
      setPages(pdf.numPages)
      const pdfPage = await pdf.getPage(Math.min(page, pdf.numPages))
      const original = pdfPage.getViewport({ scale: 1 })
      const viewport = pdfPage.getViewport({ scale: Math.min(1.5, 1000 / original.width, Math.sqrt(4000000 / (original.width * original.height))) })
      const target = canvas.current
      if (!active || !target) return
      target.width = Math.ceil(viewport.width); target.height = Math.ceil(viewport.height)
      renderTask = pdfPage.render({ canvasContext: target.getContext('2d'), viewport })
      await renderTask.promise
      if (active) target.dataset.rendered = 'true'
    })().catch(e => { if (active) { setError('附件无法预览，请下载后查看'); setKind('download') } })
    return () => { active = false; renderTask?.cancel(); task?.destroy().catch(() => {}); if (url) URL.revokeObjectURL(url) }
  }, [dataUrl, page])
  return <div className="w-full min-w-0" data-testid="safe-attachment-preview" data-preview-kind={kind}>
    {kind === 'loading' && <p className="p-6 text-center text-sm text-slate-400">加载中…</p>}
    {kind === 'image' && <img src={imageUrl} alt={name} className="mx-auto max-h-[60vh] max-w-full rounded-lg object-contain" />}
    <canvas ref={canvas} aria-label={`${name} · PDF预览`} className={kind === 'pdf' ? 'mx-auto max-w-full rounded-lg' : 'hidden'} />
    {kind === 'pdf' && pages > 1 && <div className="mt-3 flex items-center justify-center gap-3 text-sm"><button disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="btn-secondary">上一页</button><span>{page} / {pages}</span><button disabled={page >= pages} onClick={() => setPage(p => p + 1)} className="btn-secondary">下一页</button></div>}
    {kind === 'download' && <p className="p-6 text-center text-sm text-slate-500">{error || '该文件仅支持下载查看，不会在页面中打开活动内容'}</p>}
  </div>
}
