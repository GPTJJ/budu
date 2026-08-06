import { useRef, useState } from 'react'
import { ArrowLeft, ImagePlus, Loader2, Package, Trash2, UploadCloud, X } from 'lucide-react'
import { allMonths, monthLabel, products, STORES } from '../utils/selectors'
import { formatMoney, formatNumber } from '../utils/format'
import { commitProductImages, getProductImages } from '../utils/userData'
import { useI18n } from '../i18n'

const inputCls =
  'w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none transition focus:border-budu-400 focus:ring-2 focus:ring-budu-100'

function resizeImage(file, maxSize = 512) {
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
        resolve(canvas.toDataURL('image/jpeg', 0.82))
      }
      img.onerror = () => reject(new Error('图片读取失败'))
      img.src = reader.result
    }
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.readAsDataURL(file)
  })
}

function ProductDetailModal({ product, image, onClose, onSaveImage, onRemoveImage, busy }) {
  const { t } = useI18n()
  const fileRef = useRef(null)
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg rounded-3xl bg-white p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <h3 className="text-lg font-bold text-slate-800">{t('商品详情')}</h3>
          <button
            onClick={onClose}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-slate-50 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
            aria-label={t('关闭')}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-5 flex flex-col items-center gap-4">
          <div className="grid h-44 w-44 place-items-center overflow-hidden rounded-3xl bg-gradient-to-br from-budu-50 to-grape-50 shadow-inner">
            {image ? (
              <img src={image} alt={product.name} className="h-full w-full object-cover" />
            ) : (
              <span className="text-5xl text-budu-300">{product.name.slice(0, 1)}</span>
            )}
          </div>

          <div className="w-full text-center">
            <p className="text-base font-bold text-slate-800">{product.name}</p>
          </div>

          <div className="grid w-full grid-cols-2 gap-2.5">
            <div className="rounded-xl bg-budu-50/70 px-4 py-3 text-center">
              <p className="text-[10px] font-semibold text-budu-500">{t('销量')}</p>
              <p className="mt-0.5 text-base font-bold text-slate-700">
                {formatNumber(Math.round(product.sales))}
              </p>
            </div>
            <div className="rounded-xl bg-grape-50/70 px-4 py-3 text-center">
              <p className="text-[10px] font-semibold text-grape-500">{t('销售额')}</p>
              <p className="mt-0.5 text-base font-bold text-slate-700">¥{formatMoney(product.amount)}</p>
            </div>
            <div className="rounded-xl bg-amber-50/70 px-4 py-3 text-center">
              <p className="text-[10px] font-semibold text-amber-600">{t('收入')}</p>
              <p className="mt-0.5 text-base font-bold text-slate-700">¥{formatMoney(product.income)}</p>
            </div>
            <div className="rounded-xl bg-rose-50/70 px-4 py-3 text-center">
              <p className="text-[10px] font-semibold text-rose-500">{t('优惠')}</p>
              <p className="mt-0.5 text-base font-bold text-slate-700">¥{formatMoney(product.discount)}</p>
            </div>
          </div>

          <div className="flex w-full items-center justify-center gap-2.5">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              disabled={busy}
              onChange={async (e) => {
                const file = e.target.files && e.target.files[0]
                e.target.value = ''
                if (file) onSaveImage(await resizeImage(file))
              }}
            />
            <button
              onClick={() => fileRef.current && fileRef.current.click()}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-xl bg-budu-50 px-4 py-2 text-sm font-semibold text-budu-600 transition hover:bg-budu-100 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
              {t('上传图片')}
            </button>
            {image && (
              <button
                onClick={onRemoveImage}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-xl bg-rose-50 px-4 py-2 text-sm font-semibold text-rose-500 transition hover:bg-rose-100 disabled:opacity-50"
              >
                <Trash2 className="h-4 w-4" />
                {t('移除图片')}
              </button>
            )}
          </div>
          <p className="text-center text-xs text-slate-400">{t('支持从本机选择图片，自动压缩保存')}</p>
        </div>
      </div>
    </div>
  )
}

export default function ProductCatalogPage({ initialProduct = null, onBack }) {
  const { lang, t } = useI18n()
  const [month, setMonth] = useState(() => {
    const months = allMonths()
    return months.length > 0 ? months[months.length - 1].key : '2026-07'
  })
  const [store, setStore] = useState('all')
  const [selectedName, setSelectedName] = useState(initialProduct)
  const [version, setVersion] = useState(0)
  const [busy, setBusy] = useState(false)
  const images = getProductImages()

  const list = products(month, store)
  const selected = list.find((p) => p.name === selectedName) || (selectedName ? { name: selectedName, sales: 0, amount: 0, income: 0, discount: 0 } : null)

  const saveImage = async (dataUrl) => {
    if (!selected) return
    setBusy(true)
    try {
      commitProductImages({ ...images, [selected.name]: dataUrl })
      setVersion((v) => v + 1)
    } finally {
      setBusy(false)
    }
  }

  const removeImage = () => {
    if (!selected || !window.confirm(t('确定移除该商品的图片吗？'))) return
    const next = { ...images }
    delete next[selected.name]
    commitProductImages(next)
    setVersion((v) => v + 1)
  }

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
            <Package className="h-5 w-5 text-budu-500" />
            {t('商品目录')}
          </h2>
          <p className="mt-0.5 text-[13px] text-slate-400">{t('根据菜品销售明细，为每一款菜品提供独立展示')}</p>
        </div>
        <div className="ml-auto flex items-center gap-2.5">
          <select value={month} onChange={(e) => setMonth(e.target.value)} className={inputCls}>
            {allMonths().map((m) => (
              <option key={m.key} value={m.key}>
                {monthLabel(m.key, lang)}
              </option>
            ))}
          </select>
          <select value={store} onChange={(e) => setStore(e.target.value)} className={inputCls}>
            <option value="all">{t('全部门店')}</option>
            {STORES.map((s) => (
              <option key={s.key} value={s.key}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {list.length > 0 ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
          {list.map((p) => {
            const img = images[p.name]
            return (
              <button
                key={p.name}
                onClick={() => setSelectedName(p.name)}
                className="card group flex flex-col items-center p-4 text-center transition-all duration-200 hover:-translate-y-0.5 hover:shadow-card-hover"
              >
                <div className="grid h-24 w-24 place-items-center overflow-hidden rounded-2xl bg-gradient-to-br from-budu-50 to-grape-50 shadow-inner">
                  {img ? (
                    <img src={img} alt={p.name} className="h-full w-full object-cover" />
                  ) : (
                    <span className="text-3xl text-budu-300">{p.name.slice(0, 1)}</span>
                  )}
                </div>
                <p className="mt-3 line-clamp-2 w-full text-[13px] font-semibold text-slate-700 group-hover:text-budu-600">
                  {p.name}
                </p>
                <p className="mt-1.5 w-full text-[11px] text-slate-400">
                  {t('销量')} {formatNumber(Math.round(p.sales))} · ¥{formatMoney(p.amount)}
                </p>
                {img && (
                  <span className="mt-1.5 inline-flex items-center gap-1 rounded-md bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-600">
                    <ImagePlus className="h-3 w-3" />
                    {t('已上传')}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      ) : (
        <div className="card grid place-items-center py-20 text-sm text-slate-300">{t('暂无商品数据')}</div>
      )}

      {selected && (
        <ProductDetailModal
          product={selected}
          image={images[selected.name]}
          busy={busy}
          onClose={() => setSelectedName(null)}
          onSaveImage={saveImage}
          onRemoveImage={removeImage}
        />
      )}
    </div>
  )
}
