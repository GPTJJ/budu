import { useEffect, useState } from 'react'
import { createDeliveryPackage, saveDeliveryFile, svgToPng } from '../utils/sweetCardDelivery'

export default function SweetCardDelivery({ delivery, onClose, onCopy, onRevoke, saving }) {
  const [png, setPng] = useState(null)
  const [zip, setZip] = useState(null)
  const [preview, setPreview] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [retry, setRetry] = useState(0)
  const proof = delivery.proofDelivery?.proof
  const revoked = delivery.claimAsset.state === 'REVOKED'
  const name = (delivery.claimAsset.fileName || 'sweet-card').replace(/\.svg$/i, '')
  useEffect(() => {
    let active = true, url
    setPng(null); setPreview(''); setMessage('正在准备图片…')
    svgToPng(delivery.claimAsset.svgBase64).then(blob => {
      if (!active) return
      url = URL.createObjectURL(blob)
      setPreview(url); setPng(new File([blob], `${name}.png`, { type: 'image/png' })); setMessage('')
    }).catch(() => { if (active) setMessage('图片准备失败，请重试。不会重新生成领取凭证。') })
    return () => { active = false; if (url) URL.revokeObjectURL(url) }
  }, [delivery.claimAsset.svgBase64, name, retry])
  useEffect(() => {
    let active = true
    setZip(null)
    if (png && proof && !revoked) createDeliveryPackage(png, proof).then(blob => {
      if (active) setZip({ proof, file: new File([blob], `${name}.zip`, { type: 'application/zip' }) })
    }).catch(() => { if (active) setMessage('保存包准备失败，请重试。') })
    return () => { active = false }
  }, [png, proof, revoked, name])
  const run = async (fn) => {
    if (busy) return
    setBusy(true); setMessage('')
    try { setMessage(await fn() || '领取凭证已复制。请安全保存。') }
    catch (error) { setMessage(error?.name === 'AbortError' ? '已取消保存，可以再次点击。' : '操作失败，请重试；不会重新生成领取凭证。') }
    finally { setBusy(false) }
  }
  const button = 'min-h-11 rounded-xl border border-budu-200 px-3 py-2 font-bold text-budu-600 disabled:opacity-50'
  return <div className="fixed inset-0 z-[130] flex items-end bg-slate-950/70 backdrop-blur-sm sm:items-center sm:justify-center sm:p-6" role="dialog" aria-modal="true" aria-label="电子卡交付">
    <div className="max-h-[94dvh] w-full overflow-y-auto rounded-t-[30px] bg-white p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl sm:max-w-xl sm:rounded-[30px]">
      <div className="flex items-start justify-between gap-3"><h2 className="text-xl font-black">{delivery.claimAsset.carrierType === 'ELECTRONIC' ? '电子卡已生成' : '实体卡领取二维码已生成'}</h2><button className={button} onClick={onClose}>关闭</button></div>
      <p className="mt-4 rounded-2xl bg-amber-50 p-4 text-sm leading-6 text-amber-900">管理员保存包包含电子卡图片和独立领取凭证，请妥善保管。向顾客交付时请分渠道发送；卡面领取码不能用于 POS 消费。</p>
      {preview && <div className="mt-4 overflow-auto rounded-2xl border border-rose-100" aria-label="电子卡图片"><img alt="微信扫码领取甜意卡卡面预览" src={preview} className={expanded ? 'max-w-none' : 'w-full'} style={expanded ? { width: '150%' } : undefined} /></div>}
      <p role="status" className="my-3 break-words text-sm text-budu-700">{message}</p>
      {!png && <button className={button} onClick={() => setRetry(x => x + 1)}>重试准备图片</button>}
      <div className="grid gap-2 sm:grid-cols-2">
        <button className={button} disabled={!png || revoked} onClick={() => setExpanded(x => !x)}>{expanded ? '收起电子卡' : '查看电子卡'}</button>
        <button className={button} disabled={!png || busy || revoked} onClick={() => run(() => saveDeliveryFile(png))}>保存电子卡 PNG</button>
        <button className={`${button} sm:col-span-2`} disabled={!zip || zip.proof !== proof || !proof || busy || revoked} onClick={() => run(() => saveDeliveryFile(zip.file))}>保存管理员文件包 ZIP</button>
        <button className={`${button} sm:col-span-2`} disabled={!proof || busy || revoked} onClick={() => run(onCopy)}>{delivery.proofCopied ? '凭证已复制并从页面清除' : '复制独立领取凭证'}</button>
      </div>
      <p className="mt-3 text-xs text-slate-500">文件包包含电子卡.png 和领取凭证.txt。建议先保存文件包，再复制凭证。复制或关闭后，页面不再保留可打包的凭证；不会自动补发。</p>
      <button className={`${button} mt-3 w-full text-rose-600`} disabled={saving || busy || revoked} onClick={onRevoke}>{revoked ? '领取资产已撤销' : '撤销领取资产'}</button>
    </div>
  </div>
}
