import { useEffect, useState } from 'react'
import { ArrowLeft, Check, Copy } from 'lucide-react'

const STORAGE_KEY = 'budu-store-mailing'

function loadSaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

async function copyText(text) {
  if (!text) return false
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    /* 降级方案：兼容部分 WebView / 非安全上下文 */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

function OptionGroup({ label, options, value, onChange }) {
  return (
    <div>
      <p className="mb-2 text-sm font-medium text-slate-600">{label}</p>
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
        {options.map((opt) => {
          const active = value === opt
          return (
            <button
              key={opt}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(opt)}
              className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
                active
                  ? 'bg-budu-50 text-budu-700 ring-1 ring-budu-200'
                  : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              {opt}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export default function StoreMailingPage({ onBack }) {
  const saved = loadSaved()
  const [method, setMethod] = useState(saved?.method || '顺丰邮寄')
  const [postage, setPostage] = useState(saved?.postage || '包邮')
  const [fee, setFee] = useState(saved?.fee || '标准件18¥')
  const [address, setAddress] = useState(saved?.address || '')
  const [recipient, setRecipient] = useState(saved?.recipient || '')
  const [phone, setPhone] = useState(saved?.phone || '')
  const [remark, setRemark] = useState(saved?.remark || '')
  const [copied, setCopied] = useState('')

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ method, postage, fee, address, recipient, phone, remark }))
    } catch {
      /* 隐私模式等场景忽略 */
    }
  }, [method, postage, fee, address, recipient, phone, remark])

  useEffect(() => {
    if (!copied) return undefined
    const id = setTimeout(() => setCopied(''), 1600)
    return () => clearTimeout(id)
  }, [copied])

  const handleCopy = async (key, text) => {
    const ok = await copyText(text)
    if (ok) setCopied(key)
  }

  const copyAll = async () => {
    const lines = [`收件地址：${address}`, `收件人：${recipient}`, `联系方式：${phone}`]
    if (remark) lines.push(`备注：${remark}`)
    const ok = await copyText(lines.join('\n'))
    if (ok) setCopied('all')
  }

  const fieldCls = 'input'

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBack}
          className="btn-secondary px-3 py-2"
        >
          <ArrowLeft className="h-4 w-4" />
          返回
        </button>
        <p className="text-sm text-slate-400">填写内容自动保存在本机，便于下次直接复制</p>
      </div>

      <div className="card p-5 sm:p-6">
        <div className="space-y-6">
          <OptionGroup label="邮寄方式" options={['顺丰邮寄', '同城闪送']} value={method} onChange={setMethod} />
          <OptionGroup label="运费" options={['包邮', '不包邮']} value={postage} onChange={setPostage} />
          {method === '顺丰邮寄' && postage === '不包邮' && (
            <OptionGroup label="运费选项" options={['标准件18¥', '生鲜航运30¥']} value={fee} onChange={setFee} />
          )}

          <div className="space-y-4 border-t border-slate-100 pt-5">
            <p className="text-sm font-medium text-slate-600">收件信息</p>

            <div>
              <label className="mb-1.5 block text-[13px] font-medium text-slate-500">收件地址</label>
              <div className="flex gap-2">
                <textarea
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="请输入收件地址"
                  rows={2}
                  className={`${fieldCls} min-h-[72px] resize-none`}
                />
                <button
                  type="button"
                  onClick={() => handleCopy('address', address)}
                  className="btn-secondary h-10 shrink-0 px-3"
                  aria-label="复制收件地址"
                >
                  {copied === 'address' ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-[13px] font-medium text-slate-500">收件人</label>
              <div className="flex gap-2">
                <input
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  placeholder="请输入收件人姓名"
                  className={fieldCls}
                />
                <button
                  type="button"
                  onClick={() => handleCopy('recipient', recipient)}
                  className="btn-secondary h-10 shrink-0 px-3"
                  aria-label="复制收件人"
                >
                  {copied === 'recipient' ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-[13px] font-medium text-slate-500">联系方式</label>
              <div className="flex gap-2">
                <input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="请输入手机号 / 电话"
                  inputMode="tel"
                  className={fieldCls}
                />
                <button
                  type="button"
                  onClick={() => handleCopy('phone', phone)}
                  className="btn-secondary h-10 shrink-0 px-3"
                  aria-label="复制联系方式"
                >
                  {copied === 'phone' ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-[13px] font-medium text-slate-500">备注</label>
              <div className="flex gap-2">
                <textarea
                  value={remark}
                  onChange={(e) => setRemark(e.target.value)}
                  placeholder="选填，例如：工作日送达、冰袋数量等"
                  rows={2}
                  className={`${fieldCls} min-h-[56px] resize-none`}
                />
                <button
                  type="button"
                  onClick={() => handleCopy('remark', remark)}
                  className="btn-secondary h-10 shrink-0 px-3"
                  aria-label="复制备注"
                >
                  {copied === 'remark' ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
                </button>
              </div>
            </div>
          </div>

          <button type="button" onClick={copyAll} className="btn-primary w-full py-2.5">
            {copied === 'all' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {copied === 'all' ? '已复制全部收件信息' : '一键复制全部收件信息'}
          </button>
        </div>
      </div>
    </div>
  )
}
