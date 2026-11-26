import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, Sparkles, X } from 'lucide-react'
import { formatCents } from '../../../utils/pos'
import { SWEET_CARD_DEFAULT_NOTE } from '../../../utils/sweetCardShare'

const PRESETS = [['100.00', '¥100'], ['200.00', '¥200'], ['500.00', '¥500']]
const fieldClass = 'w-full rounded-2xl border border-slate-200 bg-white px-3.5 py-3 text-[15px] outline-none placeholder:text-slate-300 focus:border-budu-300 focus:ring-2 focus:ring-budu-100'

function defaultName(faceValueYuan) {
  const now = new Date()
  const day = `${now.getMonth() + 1}.${now.getDate()}`
  return `甜意卡 ${day} · ¥${Number(faceValueYuan || 0)}`
}

export default function SweetCardIssueSheet({ open, onClose, onSubmit, saving, error }) {
  const [faceValueYuan, setFaceValueYuan] = useState('200.00')
  const [customOpen, setCustomOpen] = useState(false)
  const [cardCount, setCardCount] = useState('1')
  const [note, setNote] = useState(SWEET_CARD_DEFAULT_NOTE)
  const [internalNote, setInternalNote] = useState('')
  const [recipientLabel, setRecipientLabel] = useState('')
  const [validityType, setValidityType] = useState('ONE_YEAR')
  const [moreOpen, setMoreOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    setCustomOpen(false); setMoreOpen(false); setCardCount('1')
    setNote(SWEET_CARD_DEFAULT_NOTE); setInternalNote(''); setRecipientLabel('')
  }, [open])

  const totalCents = useMemo(() => {
    const yuan = Number(faceValueYuan)
    const count = Number(cardCount)
    if (!Number.isFinite(yuan) || yuan <= 0 || !Number.isFinite(count) || count <= 0) return 0n
    return BigInt(Math.round(yuan * 100)) * BigInt(count)
  }, [faceValueYuan, cardCount])

  const submit = () => {
    onSubmit({
      name: defaultName(faceValueYuan),
      purpose: internalNote.trim(),
      businessPurpose: 'COMMERCIAL',
      cardCount: Number(cardCount) || 1,
      faceValueYuan,
      validityType,
      carrierType: 'ELECTRONIC',
      bindingMode: 'OPTIONAL',
      recipientType: '',
      recipientLabel: recipientLabel.trim(),
      recipientCompany: '',
      recipientNote: (note.trim() || SWEET_CARD_DEFAULT_NOTE).slice(0, 300),
      giftingScenario: '',
      activateNow: true,
    })
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[130] flex items-end bg-slate-950/55 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-label="创建甜意卡">
      <div className="flex max-h-[93dvh] w-full flex-col rounded-t-[26px] bg-[#FBF7F8] shadow-modal" style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}>
        <div className="flex items-center justify-between border-b border-rose-100/80 px-4 py-3">
          <div>
            <h2 className="text-[17px] font-black text-slate-900">创建甜意卡</h2>
            <p className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-bold text-emerald-600"><Sparkles className="h-3 w-3" />创建即激活 · 待领取</p>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭" className="grid h-9 w-9 place-items-center rounded-xl bg-white text-slate-400 ring-1 ring-slate-200"><X className="h-4 w-4" /></button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          <fieldset>
            <legend className="text-[11px] font-black tracking-wide text-slate-400">面额</legend>
            <div className="mt-2 grid grid-cols-4 gap-2">
              {PRESETS.map(([value, label]) => (
                <button key={value} type="button" onClick={() => { setFaceValueYuan(value); setCustomOpen(false) }} aria-pressed={!customOpen && faceValueYuan === value} className={`h-12 rounded-2xl text-[15px] font-black transition ${!customOpen && faceValueYuan === value ? 'bg-budu-500 text-white shadow-[0_8px_20px_-10px_rgba(188,79,126,0.9)]' : 'bg-white text-slate-600 ring-1 ring-slate-200'}`}>{label}</button>
              ))}
              <button type="button" onClick={() => setCustomOpen(true)} aria-pressed={customOpen} className={`h-12 rounded-2xl text-[13px] font-black transition ${customOpen ? 'bg-budu-500 text-white' : 'bg-white text-slate-600 ring-1 ring-slate-200'}`}>自定义</button>
            </div>
            {customOpen && <input aria-label="自定义面额" inputMode="decimal" value={faceValueYuan} onChange={(e) => setFaceValueYuan(e.target.value)} placeholder="输入面额，如 888" className={`${fieldClass} mt-2`} />}
          </fieldset>

          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-[11px] font-black tracking-wide text-slate-400">数量</span>
              <input aria-label="数量" type="number" min="1" max="500" value={cardCount} onChange={(e) => setCardCount(e.target.value)} className={`${fieldClass} mt-2`} />
            </label>
            <label className="block">
              <span className="text-[11px] font-black tracking-wide text-slate-400">赠送对象 <em className="font-normal not-italic text-slate-300">可选</em></span>
              <input aria-label="赠送对象" value={recipientLabel} onChange={(e) => setRecipientLabel(e.target.value)} placeholder="例如：阿岚" className={`${fieldClass} mt-2`} />
            </label>
          </div>

          <label className="block">
            <span className="text-[11px] font-black tracking-wide text-slate-400">好友专属赠言</span>
            <textarea aria-label="好友专属赠言" rows="3" value={note} onChange={(e) => setNote(e.target.value)} placeholder={SWEET_CARD_DEFAULT_NOTE} className={`${fieldClass} mt-2 resize-none leading-6`} />
            <span className="mt-1 block text-[11px] text-slate-400">留空时使用「{SWEET_CARD_DEFAULT_NOTE}」</span>
          </label>

          <label className="block">
            <span className="text-[11px] font-black tracking-wide text-slate-400">内部备注 <em className="font-normal not-italic text-slate-300">仅自己可见</em></span>
            <input aria-label="内部备注" value={internalNote} onChange={(e) => setInternalNote(e.target.value)} placeholder="例如：中秋客户答谢 · 市场部" className={`${fieldClass} mt-2`} />
          </label>

          <button type="button" onClick={() => setMoreOpen(!moreOpen)} className="flex w-full items-center justify-between rounded-2xl bg-white px-3.5 py-2.5 text-[12px] font-bold text-slate-500 ring-1 ring-slate-200">
            更多设置
            <ChevronDown className={`h-4 w-4 transition ${moreOpen ? 'rotate-180' : ''}`} />
          </button>
          {moreOpen && <label className="block">
            <span className="text-[11px] font-black tracking-wide text-slate-400">有效期</span>
            <select aria-label="有效期" value={validityType} onChange={(e) => setValidityType(e.target.value)} className={`${fieldClass} mt-2`}>
              <option value="ONE_YEAR">1 年</option>
              <option value="THREE_YEARS">3 年</option>
              <option value="LONG_TERM">长期有效</option>
            </select>
          </label>}

          {error && <p role="alert" className="rounded-2xl bg-rose-50 px-3.5 py-2.5 text-[13px] font-semibold text-rose-700">{error}</p>}
        </div>

        <div className="border-t border-rose-100/80 bg-white/70 px-4 pb-1 pt-3">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-[11px] font-bold text-slate-400">本次发行额度</span>
            <strong className="text-[17px] font-black tabular-nums text-budu-600">{formatCents(totalCents)}</strong>
          </div>
          <button type="button" disabled={saving} onClick={submit} className="h-[50px] w-full rounded-2xl bg-budu-500 text-[15px] font-black text-white shadow-[0_12px_26px_-14px_rgba(188,79,126,1)] disabled:opacity-60">
            {saving ? '正在创建…' : '立即创建并激活'}
          </button>
        </div>
      </div>
    </div>
  )
}
