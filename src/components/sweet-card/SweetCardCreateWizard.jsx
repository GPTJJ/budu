import { useMemo, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, Gift, Plus } from 'lucide-react'
import { formatCents } from '../../utils/pos'
import { SWEET_CARD_BINDING_MODE_OPTIONS, SWEET_CARD_CARRIER_TYPE_OPTIONS } from '../../utils/sweetCardLabels'

const fieldClass = 'w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-budu-400 focus:ring-2 focus:ring-budu-100'
const labelClass = 'text-xs font-bold text-slate-500'

const STEPS = [['基本信息', '批次 · 数量 · 面额 · 有效期 · 赠送对象'], ['发卡设置', '祝福语 · 赠送信息 · 载体 · 绑定 · 用途'], ['确认并发卡', '核对后一次性提交']]

// 面额预设：只作快捷填入，最终仍走服务端 parseYuanAmount 校验。
const FACE_VALUE_PRESETS = [['500.00', '¥500'], ['1000.00', '¥1000']]

export default function SweetCardCreateWizard({ form, onChange, saving, onSubmit }) {
  const [step, setStep] = useState(1)
  const set = (patch) => onChange({ ...form, ...patch })
  const canNext = useMemo(() => {
    if (step === 1) return String(form.name || '').trim() !== '' && String(form.faceValueYuan || '').trim() !== ''
    return true
  }, [step, form.name, form.faceValueYuan])
  const totalCents = useMemo(() => {
    const yuan = Number(String(form.faceValueYuan || '0'))
    const count = Number(form.cardCount) || 0
    if (!Number.isFinite(yuan) || yuan <= 0 || !Number.isFinite(count) || count <= 0) return 0n
    return BigInt(Math.round(yuan * 100)) * BigInt(count)
  }, [form.faceValueYuan, form.cardCount])
  const validityLabel = form.validityType === 'ONE_YEAR' ? '1 年' : form.validityType === 'THREE_YEARS' ? '3 年' : '长期'
  const carrierLabel = (SWEET_CARD_CARRIER_TYPE_OPTIONS.find(([v]) => v === form.carrierType) || [])[1] || form.carrierType
  const bindingLabel = (SWEET_CARD_BINDING_MODE_OPTIONS.find(([v]) => v === form.bindingMode) || [])[1] || form.bindingMode

  return <div className="mt-4 rounded-3xl bg-white p-5 shadow-card sm:p-7">
    <div className="flex items-center gap-3"><div className="grid h-11 w-11 place-items-center rounded-2xl bg-budu-50 text-budu-600"><Gift className="h-6 w-6" /></div><div><h2 className="text-lg font-black text-slate-900">创建并发卡</h2><p className="text-xs text-slate-400">三步收集，最终一次性提交创建批次与卡片</p></div></div>

    {/* 步骤指示 */}
    <ol className="mt-5 grid grid-cols-3 gap-2" aria-label="创建步骤">
      {STEPS.map(([title, hint], index) => { const current = index + 1; const active = current === step; const done = current < step; return <button key={title} type="button" disabled={current > step} onClick={() => setStep(current)} className={`rounded-2xl border p-3 text-left transition ${active ? 'border-budu-300 bg-budu-50' : done ? 'border-budu-200 bg-white' : 'border-slate-100 bg-slate-50/60'} ${current > step ? 'cursor-not-allowed opacity-50' : ''}`}><span className={`flex items-center gap-1.5 text-xs font-black ${active ? 'text-budu-600' : done ? 'text-budu-500' : 'text-slate-400'}`}>{done ? <Check className="h-3.5 w-3.5" /> : <span className="grid h-4 w-4 place-items-center rounded-full border border-current text-[10px]">{current}</span>}{title}</span><span className="mt-1 block text-[10px] leading-4 text-slate-400">{hint}</span></button> })}
    </ol>

    {step === 1 && <div className="mt-6">
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className={`${labelClass} sm:col-span-2`}>批次名称<input required value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="例如：中秋客户答谢" className={`${fieldClass} mt-1`} /></label>
        <label className={labelClass}>数量<input type="number" min="1" max="500" value={form.cardCount} onChange={(e) => set({ cardCount: e.target.value })} className={`${fieldClass} mt-1`} /><span className="mt-1 block text-[10px] font-normal text-slate-400">1–500 张</span></label>
        <label className={labelClass}>面额（元）<input aria-label="面额（元）" inputMode="decimal" required value={form.faceValueYuan} onChange={(e) => set({ faceValueYuan: e.target.value })} placeholder="500.00" className={`${fieldClass} mt-1`} />
          <span className="mt-2 flex gap-2">{FACE_VALUE_PRESETS.map(([value, label]) => <button key={value} type="button" onClick={() => set({ faceValueYuan: value })} className={`rounded-full px-3 py-1 text-xs font-bold ${form.faceValueYuan === value ? 'bg-budu-500 text-white' : 'bg-budu-50 text-budu-600'}`}>{label}</button>)}</span></label>
        <label className={labelClass}>有效期<select value={form.validityType} onChange={(e) => set({ validityType: e.target.value })} className={`${fieldClass} mt-1`}><option value="ONE_YEAR">1 年</option><option value="THREE_YEARS">3 年</option><option value="LONG_TERM">长期</option></select></label>
        <label className={labelClass}>赠送对象<input value={form.recipientLabel} onChange={(e) => set({ recipientLabel: e.target.value })} placeholder="可选" className={`${fieldClass} mt-1`} /></label>
      </div>
    </div>}

    {step === 2 && <div className="mt-6">
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className={`${labelClass} sm:col-span-2`}>祝福语<input value={form.recipientNote} onChange={(e) => set({ recipientNote: e.target.value })} placeholder="可选，展示在电子卡卡面" className={`${fieldClass} mt-1`} /></label>
        <p className="text-xs font-black text-slate-400 sm:col-span-2">赠送信息</p>
        <label className={labelClass}>赠送对象类型（可选）<input value={form.recipientType} onChange={(e) => set({ recipientType: e.target.value })} placeholder="例如：个人 / 企业" className={`${fieldClass} mt-1`} /></label>
        <label className={labelClass}>公司（可选）<input value={form.recipientCompany} onChange={(e) => set({ recipientCompany: e.target.value })} className={`${fieldClass} mt-1`} /></label>
        <label className={`${labelClass} sm:col-span-2`}>赠送场景（可选）<input value={form.giftingScenario} onChange={(e) => set({ giftingScenario: e.target.value })} className={`${fieldClass} mt-1`} /></label>
        <p className="text-xs font-black text-slate-400 sm:col-span-2">批次设置</p>
        <label className={labelClass}>载体<select value={form.carrierType} onChange={(e) => set({ carrierType: e.target.value })} className={`${fieldClass} mt-1`}>{SWEET_CARD_CARRIER_TYPE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className={labelClass}>绑定模式<select value={form.bindingMode} onChange={(e) => set({ bindingMode: e.target.value })} className={`${fieldClass} mt-1`}>{SWEET_CARD_BINDING_MODE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className={labelClass}>批次用途<select required value={form.businessPurpose} onChange={(e) => set({ businessPurpose: e.target.value })} className={`${fieldClass} mt-1`}><option value="COMMERCIAL">商业运营</option><option value="ACCEPTANCE_TEST">验收 / 测试</option></select></label>
        <label className={labelClass}>用途说明（可选）<input value={form.purpose} onChange={(e) => set({ purpose: e.target.value })} className={`${fieldClass} mt-1`} /></label>
        {form.carrierType === 'ELECTRONIC' && <label className="flex items-center gap-2 text-sm text-slate-600 sm:col-span-2"><input type="checkbox" checked={form.activateNow} onChange={(e) => set({ activateNow: e.target.checked })} />创建后立即激活</label>}
      </div>
    </div>}

    {step === 3 && <div className="mt-6">
      <div className="grid gap-2 rounded-2xl bg-slate-50 p-4 text-sm sm:grid-cols-2">
        <p className="flex justify-between gap-3"><span className="text-slate-400">批次名称</span><strong>{form.name || '未命名批次'}</strong></p>
        <p className="flex justify-between gap-3"><span className="text-slate-400">数量</span><strong>{form.cardCount} 张</strong></p>
        <p className="flex justify-between gap-3"><span className="text-slate-400">单卡面额</span><strong>{formatCents(Math.round(Number(form.faceValueYuan || '0') * 100))}</strong></p>
        <p className="flex justify-between gap-3"><span className="text-slate-400">总发行额度</span><strong className="text-budu-600">{formatCents(totalCents)}</strong></p>
        <p className="flex justify-between gap-3"><span className="text-slate-400">有效期</span><strong>{validityLabel}</strong></p>
        <p className="flex justify-between gap-3"><span className="text-slate-400">载体 / 绑定</span><strong>{carrierLabel} / {bindingLabel}</strong></p>
        <p className="flex justify-between gap-3 sm:col-span-2"><span className="text-slate-400">赠送对象</span><strong>{form.recipientLabel || '—'}</strong></p>
        <p className="flex justify-between gap-3 sm:col-span-2"><span className="text-slate-400">祝福语</span><strong>{form.recipientNote || '—'}</strong></p>
        <p className="flex justify-between gap-3 sm:col-span-2"><span className="text-slate-400">批次用途</span><strong>{form.businessPurpose === 'COMMERCIAL' ? '商业运营' : '验收 / 测试'}</strong></p>
      </div>
      <p className="mt-3 text-xs leading-5 text-slate-400">提交后将一次性创建批次与 {form.cardCount} 张卡，每张卡含使用凭证与发卡账务记录。请确认信息无误后提交。</p>
    </div>}

    <div className="mt-6 flex flex-wrap items-center gap-3">
      {step > 1 && <button type="button" disabled={saving} onClick={() => setStep(step - 1)} className="inline-flex min-h-12 shrink-0 items-center gap-1 whitespace-nowrap rounded-2xl border border-slate-200 px-4 font-bold text-slate-600 disabled:opacity-50"><ArrowLeft className="h-4 w-4" />上一步</button>}
      {step < 3 && <button type="button" disabled={!canNext} onClick={() => setStep(step + 1)} className="ml-auto inline-flex min-h-12 items-center gap-1 rounded-2xl bg-budu-500 px-6 font-bold text-white disabled:opacity-50">下一步<ArrowRight className="h-4 w-4" /></button>}
      {step === 3 && <button type="button" disabled={saving} onClick={onSubmit} className="ml-auto inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-budu-500 px-6 font-bold text-white disabled:opacity-50 sm:w-auto"><Plus className="h-5 w-5" />{saving ? '创建中…' : '创建并发卡'}</button>}
    </div>
  </div>
}
