import { useCallback, useEffect, useState } from 'react'
import { Check, Copy, Loader2, MessageCircle, X } from 'lucide-react'
import { formatCents } from '../../../utils/pos'
import {
  buildSharePath, copyText, isWechatMiniProgramWebview, navigateInsideMiniProgram,
  openWeixinScheme, requestClaimShareLink, shareCopy, shareFailureMessage, SWEET_CARD_DEFAULT_NOTE,
} from '../../../utils/sweetCardShare'

/**
 * 双模转发：点击「转发给微信好友」时先判定运行环境。
 * 环境 A：页面运行在小程序 web-view 内 → wx.miniProgram.navigateTo 原生转赠页（由 open-type=share 发卡片）。
 * 环境 B：普通浏览器 / Safari / PWA → 服务端生成微信 URL Scheme（weixin://dl/business/?t=...），写剪贴板并尝试唤起微信。
 * 复制的是 Scheme 而不是 https 短链：短链在实机会先停在 wxmpurl.cn 中转页白屏，Scheme 在聊天框内点击可直拉小程序。
 */
export default function SweetCardShareSheet({ open, card, onClose, onPrepareCredential, onToast }) {
  const [stage, setStage] = useState('idle')
  const [error, setError] = useState('')
  const [link, setLink] = useState('')
  const [linkKind, setLinkKind] = useState('scheme')
  const [notice, setNotice] = useState('')
  const [copied, setCopied] = useState(false)
  const inMiniProgram = isWechatMiniProgramWebview()
  const amountText = card ? formatCents(card.initialAmountCents) : ''

  const prepare = useCallback(async () => {
    if (!card) return
    setStage('preparing'); setError(''); setCopied(false); setLink(''); setNotice('')
    try {
      let credentialId = card.delivery?.activeClaimCredentialId || ''
      if (!credentialId && onPrepareCredential) credentialId = await onPrepareCredential(card)
      if (!credentialId) {
        setStage('failed'); setError('这张卡还没有可用的领取凭据，请先在卡片详情生成电子卡。'); return
      }
      if (inMiniProgram) {
        // 环境 A 只跳「原生转发承载页」，不跳领取页、不带 auto 标记：发卡人不会误领。
        const target = buildSharePath(credentialId, {
          cardId: card.id, amountText, note: card.recipientNote || SWEET_CARD_DEFAULT_NOTE,
        })
        if (!target) { setStage('failed'); setError('领取凭据引用无效，请重新生成电子卡。'); return }
        setStage('mini-ready')
        window.setTimeout(() => {
          if (!navigateInsideMiniProgram(target)) { setStage('failed'); setError('小程序转发通道不可用，请改用外部浏览器转发。'); return }
          onClose?.()
        }, 240)
        return
      }
      const share = await requestClaimShareLink(card.id)
      setLink(share.link)
      setLinkKind(share.kind)
      if (share.notice === 'CLAIM_RELEASE_PAGE_PENDING') setNotice(share.noticeDetail || '小程序正式版还没更新到免密领取页，好友打开会看到旧版领取页')
      setStage('browser-ready')
    } catch (e) {
      setStage('failed')
      setError(shareFailureMessage(e))
    }
  }, [card, inMiniProgram, onClose, onPrepareCredential, amountText])

  useEffect(() => { if (open) prepare(); else { setStage('idle'); setError(''); setLink(''); setNotice(''); setCopied(false) } }, [open, prepare])

  const copyAndOpen = async () => {
    const text = shareCopy(amountText, link)
    const ok = await copyText(text)
    setCopied(ok)
    onToast?.(ok ? '文案与链接已复制，去微信粘贴发送吧' : '复制失败，请长按下方链接手动复制')
    if (ok) openWeixinScheme()
  }

  const copyLinkOnly = async () => {
    const ok = await copyText(link)
    setCopied(ok)
    onToast?.(ok ? '链接已复制' : '复制失败，请长按链接手动复制')
  }

  if (!open || !card) return null

  return (
    <div className="fixed inset-0 z-[150] flex items-end bg-slate-950/55 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-label="转发甜意卡">
      <div className="w-full rounded-t-[26px] bg-white shadow-modal" style={{ paddingBottom: 'max(14px, env(safe-area-inset-bottom))' }}>
        <div className="flex items-center justify-between px-4 py-3">
          <h2 className="text-[16px] font-black text-slate-900">转发给微信好友</h2>
          <button type="button" onClick={onClose} aria-label="关闭" className="grid h-9 w-9 place-items-center rounded-xl bg-slate-100 text-slate-400"><X className="h-4 w-4" /></button>
        </div>

        <div className="px-4">
          <div className="rounded-2xl bg-[linear-gradient(135deg,#9E345B,#681B38)] px-4 py-3.5 text-white">
            <p className="text-[10px] font-bold tracking-[0.22em] text-white/55">budu SWEET CARD · 甜意卡</p>
            <p className="mt-1 text-[24px] font-black leading-none tabular-nums">{amountText}</p>
            <p className="mt-1.5 text-[11px] text-white/65">{card.recipientNote || 'With a little sweetness, from budu.'}</p>
          </div>

          <p className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-[11px] leading-5 text-slate-500">
            当前环境：{inMiniProgram ? '微信小程序内（原生卡片转发）' : '手机浏览器 / PWA（微信 URL Scheme）'}
          </p>

          {stage === 'preparing' && <p className="mt-4 flex items-center justify-center gap-2 py-6 text-[13px] font-bold text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />正在准备转发…</p>}

          {stage === 'mini-ready' && <p className="mt-4 flex items-center justify-center gap-2 py-6 text-[13px] font-bold text-emerald-600"><Check className="h-4 w-4" />正在打开原生转赠页…</p>}

          {stage === 'browser-ready' && <div className="mt-3 space-y-2">
            <p className="rounded-xl bg-rose-50/70 px-3 py-2.5 text-[12px] leading-5 text-rose-800">
              {shareCopy(amountText, link)}
            </p>
            <div className="flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-[12px] font-mono text-slate-600">{link}</span>
              <button type="button" onClick={copyLinkOnly} className="shrink-0 rounded-lg bg-white px-2 py-1 text-[11px] font-bold text-slate-600 ring-1 ring-slate-200"><Copy className="mr-0.5 inline h-3 w-3" />链接</button>
            </div>
            <button type="button" onClick={copyAndOpen} className="mt-1 flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-[#07C160] text-[15px] font-black text-white">
              <MessageCircle className="h-[18px] w-[18px]" />{copied ? '已复制 · 去微信粘贴' : '复制文案并打开微信'}
            </button>
            {notice && (
              <p className="rounded-xl bg-amber-50 px-3 py-2 text-[11px] leading-4 text-amber-800">{notice}</p>
            )}
            <p className="text-center text-[10px] leading-4 text-slate-400">
              {linkKind === 'scheme'
                ? '链接 7 天内有效；在微信聊天框内点击「weixin://」链接可直接拉起小程序领取页。'
                : '短链 7 天内有效；微信内打开即直达领取页，无需输入任何激活码。'}
            </p>
          </div>}

          {stage === 'failed' && <div className="mt-4 space-y-3">
            <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2.5 text-[12px] font-bold text-rose-700">{error}</p>
            <button type="button" onClick={prepare} className="h-11 w-full rounded-2xl bg-slate-900 text-[13px] font-black text-white">重试</button>
          </div>}
        </div>
      </div>
    </div>
  )
}
