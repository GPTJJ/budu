import { useRef, useState } from 'react'
import { Download, X } from 'lucide-react'
import { toPng } from 'html-to-image'
import { allStores } from '../utils/selectors'
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
  const isTransfer = request.type === 'transfer'
  const items = request.items || []
  const storeLabel = (key, name) => name || allStores().find((s) => s.key === key)?.name || key
  const submittedAt = request.createdAt ? new Date(request.createdAt).toLocaleString() : new Date().toLocaleString()

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

  return (
    <>
      <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative flex max-h-[90vh] w-full max-w-md flex-col overflow-hidden rounded-3xl bg-white shadow-2xl">
        {/* 可下载的清单卡片 */}
        <div ref={cardRef} className="min-w-0 bg-white px-6 py-5">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <div>
              <p className="bg-gradient-to-r from-budu-500 to-grape-500 bg-clip-text text-lg font-black tracking-wide text-transparent">
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
                <span className="w-5 text-center text-[11px] font-bold text-slate-300">{idx + 1}</span>
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${CATEGORY_STYLE[it.category] || CATEGORY_STYLE.product}`}>
                  {t(CATEGORY_LABEL[it.category] || '产品')}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-slate-700">
                  {it.productName}
                </span>
                <span className="shrink-0 text-[13px] font-bold text-slate-700">× {it.quantity}</span>
                {it.note && <span className="shrink-0 text-[10px] text-slate-400">（{it.note}）</span>}
              </div>
            ))}
          </div>

          <p className="mt-3 text-center text-[10px] text-slate-300">
            {t('budu 甜蜜运营系统 · 货品清单 · 请按清单找货')}
          </p>
        </div>

        {/* 操作按钮（不进入下载图片） */}
        <div className="flex gap-2 border-t border-slate-100 px-5 py-4">
          <button
            onClick={onClose}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-500 transition hover:bg-slate-200"
          >
            <X className="h-4 w-4" />
            {t('关闭')}
          </button>
          <button
            onClick={download}
            disabled={busy}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-budu-500 to-grape-500 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-budu-200/60 transition hover:opacity-90 disabled:opacity-50"
          >
            <Download className="h-4 w-4" />
            {busy ? t('生成中…') : t('下载图片')}
          </button>
        </div>
      </div>
      </div>

      {/* 移动端长按保存预览 */}
      {previewUrl && (
        <div className="fixed inset-0 z-[95] flex items-center justify-center bg-slate-900/85 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm overflow-hidden rounded-3xl bg-white p-4 shadow-2xl">
            <img src={previewUrl} alt={t('货品清单')} className="w-full rounded-2xl" />
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
