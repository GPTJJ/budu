import { Fragment, useRef, useState } from 'react'
import { Download, FileSpreadsheet, X } from 'lucide-react'
import * as XLSX from 'xlsx'
import { toPng } from 'html-to-image'
import { allStores } from '../utils/selectors'
import { resolveItemCategory } from '../utils/itemCategory'
import { useI18n } from '../i18n'

const CATEGORY_LABEL = { product: '产品', material: '物料', other: '其他' }
const CATEGORY_STYLE = {
  product: 'bg-budu-50 text-budu-600',
  material: 'bg-emerald-50 text-emerald-600',
  other: 'bg-slate-100 text-slate-500',
}

export default function InventoryListModal({ request, onClose }) {
  const { t } = useI18n()
  const cardRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [previewUrl, setPreviewUrl] = useState(null)
  const [exportOpen, setExportOpen] = useState(false)
  const isTransfer = request.type === 'transfer'
  const items = request.items || []
  const storeLabel = (key, name) => name || allStores().find((s) => s.key === key)?.name || key
  const submittedAt = request.createdAt ? new Date(request.createdAt).toLocaleString() : new Date().toLocaleString()
  const totalQty = items.reduce((s, it) => s + (Number(it.quantity) || 0), 0)
  const catOf = (it) => resolveItemCategory(it.productName, it.category)
  const sections = ['product', 'material', 'other']
    .map((c) => ({
      category: c,
      items: items.filter((it) => catOf(it) === c),
    }))
    .filter((s) => s.items.length > 0)
  const typeLabel = t(isTransfer ? '调货申请' : '采购申请')
  const statusLabel = t(request.status === 'done' ? '已处理' : '待处理')
  const storeLine = isTransfer
    ? t('从 {from} 调往 {to}', {
        from: storeLabel(request.fromStoreKey, request.fromStoreName),
        to: storeLabel(request.storeKey, request.storeName),
      })
    : t('采购至 {store}', { store: storeLabel(request.storeKey, request.storeName) })

  const download = async () => {
    if (!cardRef.current || busy) return
    setBusy(true)
    try {
      const dataUrl = await toPng(cardRef.current, { pixelRatio: 2, cacheBust: true })
      const fileName = `${t('货品清单')}-${(request.createdAt || new Date().toISOString()).slice(0, 10)}.png`
      const isTouch =
        /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || navigator.maxTouchPoints > 1

      if (isTouch) {
        // 移动端：优先调起系统分享（可“存储图像”或发微信）
        try {
          const blob = await (await fetch(dataUrl)).blob()
          const file = new File([blob], fileName, { type: 'image/png' })
          if (navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], title: t('货品清单') })
            return
          }
        } catch {
          /* 用户取消或系统不支持，继续走长按保存 */
        }
        // 兜底：弹出图片，长按保存到相册
        setPreviewUrl(dataUrl)
        return
      }

      // 桌面端：直接下载
      const a = document.createElement('a')
      a.href = dataUrl
      a.download = fileName
      a.click()
    } catch {
      /* 截图失败时提示用户手动截图 */
    } finally {
      setBusy(false)
    }
  }

  const exportExcel = () => {
    const rows = [
      ['budu · 货品清单'],
      [`${t('申请类型')}：${typeLabel} · ${t('状态')}：${statusLabel}`],
      [storeLine],
      [`${t('由 {name} 提交', { name: request.createdBy || '—' })} · ${submittedAt}`],
    ]
    if (request.note) rows.push([`${t('备注：{note}', { note: request.note })}`])
    rows.push([])
    rows.push([t('序号'), t('分类'), t('货品名称'), t('数量'), t('备注')])
    const merges = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 4 } }]
    for (const sec of sections) {
      const secQty = sec.items.reduce((s, it) => s + (Number(it.quantity) || 0), 0)
      const secRow = rows.length
      rows.push([`【${t(CATEGORY_LABEL[sec.category])}】 ${t('共 {n} 种', { n: sec.items.length })} · ${t('数量')} ${secQty}`, '', '', '', ''])
      merges.push({ s: { r: secRow, c: 0 }, e: { r: secRow, c: 4 } })
      sec.items.forEach((it, idx) => {
        rows.push([
          idx + 1,
          t(CATEGORY_LABEL[catOf(it)]),
          it.productName,
          it.quantity,
          it.note || '',
        ])
      })
    }
    rows.push([t('合计'), t('共 {n} 种', { n: items.length }), '', totalQty, ''])
    const ws = XLSX.utils.aoa_to_sheet(rows)
    ws['!cols'] = [{ wch: 6 }, { wch: 10 }, { wch: 34 }, { wch: 10 }, { wch: 28 }]
    ws['!merges'] = merges
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, t('货品清单'))
    const date = (request.createdAt || new Date().toISOString()).slice(0, 10).replaceAll('-', '')
    XLSX.writeFile(wb, `budu${t('货品清单')}_${date}.xlsx`)
    onClose()
  }

  return (
    <>
      <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative flex max-h-[90vh] w-full max-w-md flex-col overflow-hidden rounded-2xl bg-white shadow-lg">
        {exportOpen ? (
          /* Excel 导出预览 */
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5">
            <div className="space-y-1 rounded-2xl border border-slate-100 bg-slate-50/70 px-4 py-3 text-[12px] leading-5 text-slate-500">
              <p>
                <span className="font-semibold text-slate-600">{t('申请类型')}</span>：{typeLabel}
                {' · '}
                <span className="font-semibold text-slate-600">{t('状态')}</span>：{statusLabel}
              </p>
              <p>{storeLine}</p>
              <p>
                {t('由 {name} 提交', { name: request.createdBy || '—' })} · {submittedAt}
              </p>
              {request.note && <p>{t('备注：{note}', { note: request.note })}</p>}
            </div>

            <div className="mt-3 overflow-x-auto rounded-2xl border border-slate-100">
              <table className="w-full whitespace-nowrap text-left text-xs">
                <thead className="sticky top-0 bg-slate-50">
                  <tr className="text-[11px] uppercase tracking-wider text-slate-400">
                    <th className="px-3 py-2 font-semibold">{t('序号')}</th>
                    <th className="px-3 py-2 font-semibold">{t('分类')}</th>
                    <th className="px-3 py-2 font-semibold">{t('货品名称')}</th>
                    <th className="px-3 py-2 font-semibold">{t('数量')}</th>
                    <th className="px-3 py-2 font-semibold">{t('备注')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {sections.map((sec) => {
                    const secQty = sec.items.reduce((s, it) => s + (Number(it.quantity) || 0), 0)
                    return (
                      <Fragment key={sec.category}>
                        <tr className="bg-budu-50/40">
                          <td colSpan={5} className="px-3 py-2 text-xs font-bold text-slate-700">
                            【{t(CATEGORY_LABEL[sec.category])}】 {t('共 {n} 种', { n: sec.items.length })} ·{' '}
                            {t('数量')} {secQty}
                          </td>
                        </tr>
                        {sec.items.map((it, idx) => (
                          <tr key={idx} className="text-slate-600">
                            <td className="px-3 py-2 font-bold text-slate-300">{idx + 1}</td>
                            <td className="px-3 py-2">
                              <span
                                className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                                  CATEGORY_STYLE[catOf(it)] || CATEGORY_STYLE.product
                                }`}
                              >
                                {t(CATEGORY_LABEL[catOf(it)])}
                              </span>
                            </td>
                            <td className="px-3 py-2 font-semibold text-slate-700">{it.productName}</td>
                            <td className="px-3 py-2 font-bold tabular-nums text-slate-700">× {it.quantity}</td>
                            <td className="px-3 py-2 text-slate-400">{it.note}</td>
                          </tr>
                        ))}
                      </Fragment>
                    )
                  })}
                  <tr className="bg-budu-50/40 font-bold text-slate-700">
                    <td className="px-3 py-2">{t('合计')}</td>
                    <td className="px-3 py-2">{t('共 {n} 种', { n: items.length })}</td>
                    <td />
                    <td className="px-3 py-2 tabular-nums">× {totalQty}</td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-center text-[10px] text-slate-300">{t('预览导出内容，确认后下载')}</p>
          </div>
        ) : (
          /* 可下载的清单卡片 */
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div ref={cardRef} className="min-w-0 bg-white px-6 py-5">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <div>
              <p className="text-lg font-bold tracking-wide text-budu-600">
                budu · {t('货品清单')}
              </p>
              <p className="mt-0.5 text-[11px] text-slate-400">
                {t(isTransfer ? '调货申请' : '采购申请')}
                {request.status === 'done' ? ` · ${t('已处理')}` : ` · ${t('待处理')}`}
              </p>
            </div>
            <span className="rounded-lg bg-budu-50 px-2 py-1 text-xs font-bold text-budu-600">
              {t('{count} 种', { count: items.length })}
            </span>
          </div>

          <div className="mt-3 space-y-1 text-[12px] text-slate-500">
            <p>
              {isTransfer
                ? t('从 {from} 调往 {to}', {
                    from: storeLabel(request.fromStoreKey, request.fromStoreName),
                    to: storeLabel(request.storeKey, request.storeName),
                  })
                : t('采购至 {store}', { store: storeLabel(request.storeKey, request.storeName) })}
            </p>
            <p>
              {t('由 {name} 提交', { name: request.createdBy || '—' })} · {submittedAt}
            </p>
            {request.note && <p>{t('备注：{note}', { note: request.note })}</p>}
          </div>

          <div className="mt-3 divide-y divide-slate-50 rounded-2xl border border-slate-100">
            {items.map((it, idx) => (
              <div key={idx} className="flex items-center gap-2 px-3 py-2.5">
                <span className="w-5 shrink-0 text-center text-[11px] font-bold text-slate-300">{idx + 1}</span>
                <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${CATEGORY_STYLE[catOf(it)] || CATEGORY_STYLE.product}`}>
                  {t(CATEGORY_LABEL[catOf(it)])}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-slate-700">
                  {it.productName}
                </span>
                <span className="shrink-0 text-[13px] font-bold text-slate-700">× {it.quantity}</span>
                {it.note && <span className="min-w-0 max-w-[90px] truncate text-[10px] text-slate-400">（{it.note}）</span>}
              </div>
            ))}
          </div>

          <p className="mt-3 text-center text-[10px] text-slate-300">
            {t('budu 甜蜜运营系统 · 货品清单 · 请按清单找货')}
          </p>
          </div>
          </div>
        )}

        {/* 操作按钮（不进入下载图片） */}
        {exportOpen ? (
          <div className="flex gap-2 border-t border-slate-100 px-5 py-4">
            <button
              onClick={() => setExportOpen(false)}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-500 transition hover:bg-slate-200"
            >
              {t('返回修改')}
            </button>
            <button
              onClick={exportExcel}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-90"
            >
              <Download className="h-4 w-4" />
              {t('导出 Excel')}
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2 border-t border-slate-100 px-5 py-4">
            <button
              onClick={onClose}
              className="flex items-center justify-center gap-1.5 rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-500 transition hover:bg-slate-200"
            >
              <X className="h-4 w-4" />
              {t('关闭')}
            </button>
            <button
              onClick={download}
              disabled={busy}
              className="flex items-center justify-center gap-1.5 rounded-xl bg-budu-500 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-90 disabled:opacity-50"
            >
              <Download className="h-4 w-4" />
              {busy ? t('生成中…') : t('下载图片')}
            </button>
            <button
              onClick={() => setExportOpen(true)}
              className="flex items-center justify-center gap-1.5 rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-90"
            >
              <FileSpreadsheet className="h-4 w-4" />
              {t('导出表格')}
            </button>
          </div>
        )}
      </div>
      </div>

      {/* 移动端长按保存预览 */}
      {previewUrl && (
        <div className="fixed inset-0 z-[95] flex items-center justify-center bg-slate-900/85 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm overflow-hidden rounded-2xl bg-white p-4 shadow-lg">
            <img src={previewUrl} alt={t('货品清单')} className="max-h-[62vh] w-full rounded-2xl object-contain" />
            <p className="mt-3 text-center text-xs leading-5 text-slate-500">
              {t('长按图片可保存到相册；也可用浏览器打开')}
            </p>
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => {
                  const a = document.createElement('a')
                  a.href = previewUrl
                  a.target = '_blank'
                  a.rel = 'noopener'
                  a.click()
                }}
                className="flex-1 rounded-xl bg-budu-50 px-4 py-2.5 text-sm font-semibold text-budu-600 transition hover:bg-budu-100"
              >
                {t('用浏览器打开')}
              </button>
              <button
                onClick={() => setPreviewUrl(null)}
                className="flex-1 rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-500 transition hover:bg-slate-200"
              >
                {t('关闭')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
