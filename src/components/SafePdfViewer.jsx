import { useEffect, useId, useRef, useState } from 'react'
import { pdfResourceOptions, annotationIcons } from './safePdfResources.js'
import { downloadFile } from '../utils/downloadFile.js'
import 'pdfjs-dist/legacy/web/pdf_viewer.css'
import './SafePdfViewer.css'

let libraryPromise
async function pdfLibrary() {
  // The official viewer uses the API's pdfjsLib global; load the matching API first.
  if (!libraryPromise) {
    const pending = (async () => {
      const api = await import('pdfjs-dist/legacy/build/pdf.mjs')
      const [{ default: workerUrl }, viewer] = await Promise.all([
        import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
        import('pdfjs-dist/legacy/web/pdf_viewer.mjs'),
      ])
      api.GlobalWorkerOptions.workerSrc = workerUrl
      return { ...api, ...viewer }
    })()
    libraryPromise = pending
    pending.catch(() => { if (libraryPromise === pending) libraryPromise = undefined })
  }
  return libraryPromise
}

function pdfDataUrl(bytes) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(new Blob([bytes], { type: 'application/pdf' }))
  })
}

function safePdfName(name, filled = false) {
  const base = String(name || '附件').replace(/[\u0000-\u001f\\/]/g, '_').replace(/\.pdf$/i, '')
  return `${base}${filled ? '-填写副本' : ''}.pdf`
}

// PDF actions are data, never application commands. Retain fields, text comments and
// user-clicked document destinations; suppress executable/media/embedded-file actions.
function constrainAnnotations(pdf, lib, visibility) {
  const getPage = pdf.getPage.bind(pdf)
  const wrapped = new WeakSet()
  const blockedTypes = new Set(['FILEATTACHMENT', 'SOUND', 'MOVIE', 'SCREEN', 'RICHMEDIA'].map(key => lib.AnnotationType[key]))
  pdf.getPage = async (...args) => {
    const page = await getPage(...args)
    if (!wrapped.has(page)) {
      wrapped.add(page)
      const render = page.render.bind(page)
      page.render = options => render(visibility.current || options.intent === 'print' ? options : { ...options, annotationMode: lib.AnnotationMode.DISABLE })
      // WebKit versions without ReadableStream async iteration still support the
      // official text stream's reader. Consume those API chunks without parsing PDF bytes.
      if (!ReadableStream.prototype[Symbol.asyncIterator]) {
        page.getTextContent = async (options = {}) => {
          const reader = page.streamTextContent(options).getReader()
          const content = { items: [], styles: Object.create(null), lang: null }
          try {
            for (;;) {
              const { value, done } = await reader.read()
              if (done) break
              content.lang ??= value.lang
              Object.assign(content.styles, value.styles)
              content.items.push(...value.items)
            }
            return content
          } finally { reader.releaseLock() }
        }
      }
      const getAnnotations = page.getAnnotations.bind(page)
      page.getAnnotations = async (...annotationArgs) => (await getAnnotations(...annotationArgs))
        .filter(annotation => !blockedTypes.has(annotation.annotationType) && !annotation.media && !annotation.richMedia && !annotation.attachment)
        .map(annotation => {
          const safe = { ...annotation, actions: null, url: null, unsafeUrl: null, action: null, resetForm: null, setOCGState: null, attachment: null }
          if (safe.richText) {
            safe.contentsObj = { str: safe.contentsObj?.str || safe.richText.str || '', dir: safe.contentsObj?.dir || 'auto' }
            safe.richText = null
          }
          if (safe.annotationType === lib.AnnotationType.TEXT) {
            const icon = String(safe.name || 'comment').toLowerCase()
            safe.name = annotationIcons.has(icon) ? icon : 'comment'
          }
          return safe
        })
    }
    return page
  }
}

function PdfThumbnail({ state, number, revision, rotation }) {
  const canvas = useRef(null)
  useEffect(() => {
    let active = true, task
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return
      observer.disconnect()
      ;(async () => {
        const page = await state.pdf.getPage(number)
        if (!active) return
        const turn = (page.rotate + rotation) % 360
        const original = page.getViewport({ scale: 1, rotation: turn })
        const viewport = page.getViewport({ scale: Math.min(88 / original.width, 126 / original.height), rotation: turn })
        const target = canvas.current
        if (!target) return
        target.width = Math.ceil(viewport.width); target.height = Math.ceil(viewport.height)
        task = page.render({ canvasContext: target.getContext('2d'), viewport, annotationMode: state.lib.AnnotationMode.ENABLE_STORAGE })
        await task.promise
      })().catch(() => {})
    })
    if (canvas.current) observer.observe(canvas.current)
    return () => { active = false; observer.disconnect(); task?.cancel() }
  }, [state, number, revision, rotation])
  return <canvas ref={canvas} aria-label={`第 ${number} 页缩略图`} />
}

export default function SafePdfViewer({ bytes, dataUrl, downloadUrl, name }) {
  const container = useRef(null)
  const viewerElement = useRef(null)
  const runtime = useRef(null)
  const printOutput = useRef(null)
  const annotationVisibility = useRef(true)
  const formId = `budu-pdf-form-${useId().replace(/:/g, '')}`
  const [ready, setReady] = useState(false)
  const [page, setPage] = useState(1)
  const [pageInput, setPageInput] = useState('1')
  const [pages, setPages] = useState(0)
  const [scale, setScale] = useState(100)
  const [scaleInput, setScaleInput] = useState('100')
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState('')
  const [drawing, setDrawing] = useState(false)
  const [tool, setTool] = useState('none')
  const [penColor, setPenColor] = useState('#000000')
  const [markerColor, setMarkerColor] = useState('#ffff00')
  const [penWidth, setPenWidth] = useState(1)
  const [markerWidth, setMarkerWidth] = useState(12)
  const [sidebar, setSidebar] = useState(false)
  const [spread, setSpread] = useState(false)
  const [showAnnotations, setShowAnnotations] = useState(true)
  const [thumbnailRevision, setThumbnailRevision] = useState(0)
  const [rotation, setRotation] = useState(0)
  const [properties, setProperties] = useState(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [canDraw, setCanDraw] = useState(false)
  const [canPrint, setCanPrint] = useState(false)
  const [editing, setEditing] = useState({})
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    const abort = new AbortController()
    let task, viewer, isolatedForm
    let disposed = false
    const teardown = () => {
      if (disposed) return
      disposed = true
      abort.abort()
      if (runtime.current?.viewer === viewer) runtime.current = null
      viewer?.setDocument(null)
      task?.destroy().catch(() => {})
      isolatedForm?.remove()
      if (document.fullscreenElement === container.current?.closest('.budu-safe-pdf')) document.exitFullscreen().catch(() => {})
      if (printOutput.current?.dataset.pdfViewerId === formId) {
        printOutput.current.remove()
        printOutput.current = null
      }
      if (!document.querySelector('.budu-pdf-print-output')) document.body.classList.remove('budu-pdf-printing')
    }
    annotationVisibility.current = true
    setReady(false); setBusy(false); setCanDraw(false); setCanPrint(false); setError(''); setNotice(''); setDrawing(false); setTool('none'); setPenColor('#000000'); setMarkerColor('#ffff00'); setPenWidth(1); setMarkerWidth(12); setSidebar(false); setSpread(false); setShowAnnotations(true); setProperties(null); setFullscreen(false); setRotation(0); setQuery(''); setMatches(''); setEditing({})
    ;(async () => {
      const lib = await pdfLibrary()
      if (abort.signal.aborted) return
      const eventBus = new lib.EventBus()
      const linkService = new lib.PDFLinkService({ eventBus, ignoreDestinationZoom: true })
      // No external URL, named action, optional-content action or embedded file can
      // trigger app navigation, protected API calls or open a native PDF window.
      linkService.addLinkAttributes = link => { link.removeAttribute('href'); link.title = '附件中的外部链接已禁用' }
      linkService.executeNamedAction = () => {}
      linkService.executeSetOCGState = () => {}
      linkService.getAttachmentContent = async () => null
      const findController = new lib.PDFFindController({ eventBus, linkService })
      // The built-in fallback is local; it never discovers localization URLs in app DOM.
      const l10n = new lib.GenericL10n()
      viewer = new lib.PDFViewer({
        container: container.current, viewer: viewerElement.current, eventBus, linkService, findController, l10n,
        annotationMode: lib.AnnotationMode.ENABLE_FORMS, annotationEditorMode: lib.AnnotationEditorType.NONE,
        annotationEditorHighlightColors: 'yellow=#ffff00,green=#00ff00,blue=#00ffff,pink=#ff00ff,red=#ff0000',
        scriptingManager: null, downloadManager: null, enableAutoLinking: false, enablePermissions: true,
        enableHighlightFloatingButton: false, enableDetailCanvas: false, maxCanvasPixels: 8000000, maxCanvasDim: 4096,
        abortSignal: abort.signal, imageResourcesPath: `${import.meta.env.BASE_URL}pdfjs/6.4.299/images/`,
      })
      linkService.setViewer(viewer)
      // Attachments never belong to an application form, even when this component
      // is used inside one. Keep original PDF field names for official field linkage.
      isolatedForm = document.createElement('form')
      isolatedForm.id = formId
      isolatedForm.addEventListener('submit', event => event.preventDefault())
      document.body.append(isolatedForm)
      const options = { signal: abort.signal }
      document.addEventListener('fullscreenchange', () => setFullscreen(document.fullscreenElement === container.current?.closest('.budu-safe-pdf')), options)
      eventBus.on('pagesinit', () => {
        viewer.currentScaleValue = 'page-width'
        setCanDraw(viewer.annotationEditorMode !== lib.AnnotationEditorType.DISABLE)
        setCanPrint(viewer.printingAllowed)
        setPages(viewer.pagesCount); setPage(1); setPageInput('1'); setReady(true)
      }, options)
      eventBus.on('pagechanging', event => { setPage(event.pageNumber); setPageInput(String(event.pageNumber)) }, options)
      eventBus.on('scalechanging', event => { setScale(Math.round(event.scale * 100)); setScaleInput(String(Math.round(event.scale * 100))) }, options)
      eventBus.on('rotationchanging', event => setRotation(event.pagesRotation), options)
      eventBus.on('updatefindmatchescount', event => setMatches(`${event.matchesCount.current} / ${event.matchesCount.total}`), options)
      eventBus.on('updatefindcontrolstate', event => { if (event.state === lib.FindState.NOT_FOUND) setMatches('未找到') }, options)
      eventBus.on('editingstateschanged', event => { setEditing({ ...event.details }); setThumbnailRevision(value => value + 1) }, options)
      eventBus.on('annotationeditorparamschanged', event => {
        const types = lib.AnnotationEditorParamsType
        for (const [type, value] of event.details) {
          if (type === types.INK_COLOR) setPenColor(value)
          else if (type === types.INK_THICKNESS) setPenWidth(value)
          else if (type === types.HIGHLIGHT_COLOR) setMarkerColor(value)
          else if (type === types.HIGHLIGHT_THICKNESS) setMarkerWidth(value)
        }
      }, options)
      eventBus.on('annotationeditormodechanged', event => {
        setDrawing(event.mode !== lib.AnnotationEditorType.NONE && event.mode !== lib.AnnotationEditorType.DISABLE)
        setTool(event.mode === lib.AnnotationEditorType.INK ? 'ink' : event.mode === lib.AnnotationEditorType.HIGHLIGHT ? 'highlight' : 'none')
        setThumbnailRevision(value => value + 1)
      }, options)
      eventBus.on('printingallowed', event => setCanPrint(event.isAllowed), options)
      window.addEventListener('afterprint', () => {
        printOutput.current?.remove()
        printOutput.current = null
        if (!document.querySelector('.budu-pdf-print-output')) document.body.classList.remove('budu-pdf-printing')
      }, options)
      eventBus.on('annotationlayerrendered', event => {
        const layer = viewer.getPageView(event.pageNumber - 1)?.annotationLayer?.div
        layer?.querySelectorAll('input, select, textarea, button').forEach(input => input.setAttribute('form', formId))
        layer?.querySelectorAll('a').forEach(link => {
          link.removeAttribute('href')
          if (link.onclick) {
            link.setAttribute('role', 'link')
            link.tabIndex = 0
            link.onkeydown = keyEvent => {
              if (keyEvent.key === 'Enter') { keyEvent.preventDefault(); link.click() }
            }
          }
        })
      }, options)
      task = lib.getDocument({
        ...pdfResourceOptions, data: bytes.slice(),
        disableAutoFetch: true, disableStream: true, enableXfa: false, useSystemFonts: true,
        // No PDFScriptingManager or sandbox is created. Scripting is disabled at the viewer.
      })
      const pdf = await task.promise
      if (abort.signal.aborted) return
      constrainAnnotations(pdf, lib, annotationVisibility)
      runtime.current = { pdf, viewer, lib, eventBus, signal: abort.signal }
      linkService.setDocument(pdf)
      viewer.setDocument(pdf)
      viewer.pagesPromise.catch(() => {
        if (!abort.signal.aborted && runtime.current?.pdf === pdf) {
          setReady(false); setError('PDF 无法预览，请下载原件后查看'); teardown()
        }
      })
    })().catch(() => {
      if (!abort.signal.aborted) { setError('PDF 无法预览，请下载原件后查看'); teardown() }
    })
    return teardown
  }, [bytes, formId])

  const navigate = value => {
    const target = Math.max(1, Math.min(pages, Number.parseInt(value, 10) || page))
    if (runtime.current) runtime.current.viewer.currentPageNumber = target
    setPageInput(String(target))
  }
  const zoom = () => {
    if (!runtime.current) return
    runtime.current.viewer.currentScale = Math.max(0.25, Math.min(5, (Number.parseFloat(scaleInput) || scale) / 100))
    setScaleInput(String(Math.round(runtime.current.viewer.currentScale * 100)))
  }
  const toggleTool = kind => {
    const state = runtime.current
    if (!state) return
    state.viewer.annotationEditorMode = { mode: tool === kind ? state.lib.AnnotationEditorType.NONE : kind === 'highlight' ? state.lib.AnnotationEditorType.HIGHLIGHT : state.lib.AnnotationEditorType.INK }
  }
  const brush = (kind, value) => {
    const state = runtime.current
    if (!state) return
    const types = state.lib.AnnotationEditorParamsType
    const type = kind === 'color' ? tool === 'highlight' ? types.HIGHLIGHT_COLOR : types.INK_COLOR : tool === 'highlight' ? types.HIGHLIGHT_THICKNESS : types.INK_THICKNESS
    state.eventBus.dispatch('switchannotationeditorparams', { source: container.current, type, value })
    if (kind === 'color') { if (tool === 'highlight') setMarkerColor(value); else setPenColor(value) }
    else { if (tool === 'highlight') setMarkerWidth(value); else setPenWidth(value) }
  }
  const toggleAnnotations = () => {
    const state = runtime.current
    if (!state) return
    if (drawing) state.viewer.annotationEditorMode = { mode: state.lib.AnnotationEditorType.NONE }
    annotationVisibility.current = !showAnnotations
    setShowAnnotations(!showAnnotations)
    state.viewer.refresh()
  }
  const documentProperties = async () => {
    const state = runtime.current
    if (!state) return
    if (properties) { setProperties(null); return }
    try {
      const metadata = await state.pdf.getMetadata()
      if (runtime.current !== state) return
      const page = await state.pdf.getPage(1)
      if (runtime.current !== state) return
      const size = page.getViewport({ scale: 1 })
      const info = metadata.info || {}
      const date = value => value ? state.lib.PDFDateString.toDateObject(value)?.toLocaleString() || value : ''
      setProperties([
        ['文件名', name], ['文件大小', `${bytes.length.toLocaleString()} B`], ['标题', info.Title], ['作者', info.Author],
        ['主题', info.Subject], ['关键字', info.Keywords], ['创建时间', date(info.CreationDate)], ['修改时间', date(info.ModDate)],
        ['应用', info.Creator], ['PDF 制作工具', info.Producer], ['PDF 版本', info.PDFFormatVersion], ['页数', state.pdf.numPages],
        ['页面尺寸', `${Math.round(size.width * 25.4 / 72)} × ${Math.round(size.height * 25.4 / 72)} 毫米`], ['快速 Web 查看', info.IsLinearized ? '是' : '否'],
      ].map(([label, value]) => [label, value == null || value === '' ? '未提供' : String(value)]))
    } catch { if (runtime.current === state) setNotice('文档属性无法读取') }
  }
  const toggleFullscreen = async () => {
    const state = runtime.current
    if (!state) return
    try {
      const section = container.current.closest('.budu-safe-pdf')
      if (document.fullscreenElement === section) await document.exitFullscreen()
      else await section.requestFullscreen()
    } catch { if (runtime.current === state) setNotice('当前浏览器无法进入全屏') }
  }
  const find = (again = false, previous = false) => {
    runtime.current?.eventBus.dispatch('find', { source: container.current, type: again ? 'again' : '', query, phraseSearch: true, caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: previous, matchDiacritics: false })
    if (!query) setMatches('')
  }
  const saveCopy = async () => {
    const state = runtime.current
    if (!state) return
    setBusy(true); setNotice('')
    try {
      if (drawing) state.viewer.annotationEditorMode = { mode: state.lib.AnnotationEditorType.NONE }
      const saved = await state.pdf.saveDocument()
      if (runtime.current !== state) return
      const savedUrl = await pdfDataUrl(saved)
      if (runtime.current !== state) return
      const result = await downloadFile({ dataUrl: savedUrl, name: safePdfName(name, true), signal: state.signal })
      if (runtime.current !== state) return
      setNotice(result.method === 'share-cancelled' ? '已取消保存' : result.method === 'share' ? '已完成系统文件分享' : '填写副本已保存到下载文件')
    } catch (error) { if (runtime.current === state) setNotice(error.message || '保存失败，请重试') }
    finally { if (runtime.current === state) setBusy(false) }
  }
  const downloadOriginal = async () => {
    const state = runtime.current
    if (!state) return
    setBusy(true); setNotice('')
    try {
      const originalUrl = dataUrl || await pdfDataUrl(bytes)
      if (runtime.current !== state) return
      const result = await downloadFile({ dataUrl: originalUrl, downloadUrl, name: safePdfName(name), signal: state.signal })
      if (runtime.current === state && result.method === 'share-cancelled') setNotice('已取消下载')
    } catch (error) { if (runtime.current === state) setNotice(error.message || '下载失败，请重试') }
    finally { if (runtime.current === state) setBusy(false) }
  }
  const print = async () => {
    const state = runtime.current
    if (!state || !state.viewer.printingAllowed) return
    setBusy(true); setNotice('正在准备打印…')
    try {
      if (drawing) state.viewer.annotationEditorMode = { mode: state.lib.AnnotationEditorType.NONE }
      const storage = state.pdf.annotationStorage.print
      const viewerRotation = state.viewer.pagesRotation
      const output = document.createElement('div')
      output.className = 'budu-pdf-print-output'
      output.dataset.pdfViewerId = formId
      const printStyle = document.createElement('style')
      output.append(printStyle)
      const pageRules = []
      // Only trusted DOM nodes and raster page images enter the browser's print engine.
      for (let number = 1; number <= state.pdf.numPages; number++) {
        const pdfPage = await state.pdf.getPage(number)
        if (runtime.current !== state) return
        const rotation = (pdfPage.rotate + viewerRotation) % 360
        const unit = pdfPage.getViewport({ scale: 1, rotation })
        const viewport = pdfPage.getViewport({ scale: Math.min(150 / 72, 4096 / Math.max(unit.width, unit.height), Math.sqrt(8000000 / (unit.width * unit.height))), rotation })
        const canvas = document.createElement('canvas')
        canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height)
        await pdfPage.render({ canvasContext: canvas.getContext('2d'), viewport, intent: 'print', annotationMode: state.lib.AnnotationMode.ENABLE_STORAGE, printAnnotationStorage: storage }).promise
        if (runtime.current !== state) return
        const image = document.createElement('img')
        image.src = canvas.toDataURL('image/png')
        image.style.width = `${unit.width}pt`; image.style.height = `${unit.height}pt`; image.alt = ''
        image.style.page = `budu-pdf-page-${number}`
        pageRules.push(`@page budu-pdf-page-${number} { size: ${unit.width}pt ${unit.height}pt; margin: 0; }`)
        output.append(image)
        await image.decode()
        if (runtime.current !== state) return
      }
      printStyle.textContent = pageRules.join('')
      printOutput.current?.remove()
      printOutput.current = output
      document.body.append(output)
      document.body.classList.add('budu-pdf-printing')
      output.dataset.pdfPrintReady = 'true'
      setNotice('打印内容已准备，包含当前填写内容')
      window.print()
    } catch {
      if (runtime.current === state) {
        printOutput.current?.remove()
        printOutput.current = null
        if (!document.querySelector('.budu-pdf-print-output')) document.body.classList.remove('budu-pdf-printing')
        setNotice('打印准备失败，请重试')
      }
    }
    finally { if (runtime.current === state) setBusy(false) }
  }

  return <section className="budu-safe-pdf" aria-label={`${name} · PDF预览`} data-pdf-ready={ready} data-show-annotations={showAnnotations}>
    <div className="budu-safe-pdf-toolbar" role="toolbar" aria-label="PDF 工具栏">
      <button type="button" disabled={!ready || page <= 1} onClick={() => navigate(page - 1)}>上一页</button>
      <label className="budu-safe-pdf-page">页码<input aria-label="PDF页码" type="number" min="1" max={pages || 1} value={pageInput} disabled={!ready} onChange={event => setPageInput(event.target.value)} onBlur={() => navigate(pageInput)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); navigate(pageInput) } }} /><span>/ {pages}</span></label>
      <button type="button" disabled={!ready || page >= pages} onClick={() => navigate(page + 1)}>下一页</button>
      <button type="button" aria-label="缩小" disabled={!ready} onClick={() => { runtime.current.viewer.currentScale = Math.max(0.25, runtime.current.viewer.currentScale / 1.2) }}>−</button>
      <label className="budu-safe-pdf-page"><input aria-label="PDF缩放百分比" type="number" min="25" max="500" value={scaleInput} disabled={!ready} onChange={event => setScaleInput(event.target.value)} onBlur={zoom} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); zoom() } }} />%</label>
      <span aria-label="缩放比例" className="budu-safe-pdf-sr-only">{scale}%</span>
      <button type="button" aria-label="放大" disabled={!ready} onClick={() => { runtime.current.viewer.currentScale = Math.min(5, runtime.current.viewer.currentScale * 1.2) }}>+</button>
      <button type="button" disabled={!ready} onClick={() => { runtime.current.viewer.currentScaleValue = 'page-width' }}>适合宽度</button>
      <button type="button" disabled={!ready} onClick={() => { runtime.current.viewer.currentScaleValue = 'page-fit' }}>适合页面</button>
      <button type="button" disabled={!ready} onClick={() => { runtime.current.viewer.pagesRotation += 90 }}>旋转</button>
      <button type="button" disabled={!ready || !canDraw || !showAnnotations} aria-pressed={tool === 'ink'} onClick={() => toggleTool('ink')}>绘制</button>
      <button type="button" disabled={!ready || !canDraw || !showAnnotations} aria-pressed={tool === 'highlight'} onClick={() => toggleTool('highlight')}>荧光笔</button>
      <button type="button" disabled={!ready || !editing.hasSelectedEditor} onClick={() => runtime.current.eventBus.dispatch('editingaction', { source: container.current, name: 'delete' })}>移除选中笔迹</button>
      <button type="button" disabled={!ready || !editing.hasSomethingToUndo} onClick={() => runtime.current.eventBus.dispatch('editingaction', { source: container.current, name: 'undo' })}>撤销</button>
      <button type="button" disabled={!ready || !editing.hasSomethingToRedo} onClick={() => runtime.current.eventBus.dispatch('editingaction', { source: container.current, name: 'redo' })}>重做</button>
      <button type="button" disabled={!ready || busy} onClick={downloadOriginal}>下载原件</button>
      <button type="button" disabled={!ready || busy} onClick={saveCopy}>保存填写副本</button>
      <button type="button" disabled={!ready || busy || !canPrint} onClick={print}>打印</button>
      <button type="button" disabled={!ready} aria-pressed={sidebar} onClick={() => setSidebar(value => !value)}>页面侧栏</button>
      <button type="button" disabled={!ready} aria-pressed={spread} onClick={() => { const state = runtime.current; state.viewer.spreadMode = spread ? state.lib.SpreadMode.NONE : state.lib.SpreadMode.ODD; setSpread(!spread) }}>双页视图</button>
      <button type="button" disabled={!ready} aria-pressed={showAnnotations} onClick={toggleAnnotations}>{showAnnotations ? '隐藏注释' : '显示注释'}</button>
      <button type="button" disabled={!ready || typeof document === 'undefined' || !document.documentElement.requestFullscreen} onClick={toggleFullscreen}>{fullscreen ? '退出全屏' : '全屏阅读'}</button>
      <button type="button" disabled={!ready} onClick={documentProperties}>文档属性</button>
    </div>
    {drawing && <div className="budu-safe-pdf-brush" aria-label="绘制设置">
      <label>颜色<input type="color" aria-label="笔迹颜色" value={tool === 'highlight' ? markerColor : penColor} onChange={event => brush('color', event.target.value)} /></label>
      <label>粗细<input type="range" aria-label="笔迹粗细" min={tool === 'highlight' ? 1 : 0.5} max={tool === 'highlight' ? 24 : 5} step="0.5" value={tool === 'highlight' ? markerWidth : penWidth} onChange={event => brush('width', Number(event.target.value))} /></label>
      <span>选择笔迹后可移除；更改只保存在下载副本中</span>
    </div>}
    {properties && <div className="budu-safe-pdf-properties" aria-label="PDF文档属性"><dl>{properties.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><button type="button" onClick={() => setProperties(null)}>收起属性</button></div>}
    <div className="budu-safe-pdf-search">
      <input aria-label="搜索PDF" type="search" placeholder="搜索文档" value={query} disabled={!ready} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); find() } }} />
      <button type="button" disabled={!ready || !query} onClick={() => find()}>查找</button>
      <button type="button" aria-label="上一个匹配" disabled={!ready || !query} onClick={() => find(true, true)}>↑</button>
      <button type="button" aria-label="下一个匹配" disabled={!ready || !query} onClick={() => find(true)}>↓</button>
      <span role="status">{matches}</span>
    </div>
    {error ? <p className="budu-safe-pdf-message">{error}</p> : <div className="budu-safe-pdf-stage">
      {sidebar && ready && runtime.current && <nav className="budu-safe-pdf-sidebar" aria-label="PDF页面侧栏">{Array.from({ length: pages }, (_, index) => <button type="button" key={index} aria-label={`跳转到第 ${index + 1} 页`} aria-current={page === index + 1 ? 'page' : undefined} onClick={() => navigate(index + 1)}><PdfThumbnail state={runtime.current} number={index + 1} revision={thumbnailRevision} rotation={rotation} /><span>{index + 1}</span></button>)}</nav>}
      <div ref={container} className="budu-safe-pdf-container" style={{ left: sidebar ? 112 : 0 }} tabIndex="0" onSubmitCapture={event => event.preventDefault()} onInputCapture={() => setThumbnailRevision(value => value + 1)}>
        <div ref={viewerElement} className="pdfViewer" />
      </div>
      {!ready && <p className="budu-safe-pdf-message">加载 PDF 中…</p>}
    </div>}
    {notice && <p className="budu-safe-pdf-message" role="status">{notice}</p>}
  </section>
}
