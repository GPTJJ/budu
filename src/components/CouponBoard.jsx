import { useCallback, useEffect, useMemo, useState } from 'react'
import { BadgePercent, Pencil, Plus, X } from 'lucide-react'
import { api } from '../utils/api'

/**
 * 小程序优惠券（营销）
 *
 * 数据流：CloudBase `coupon_templates` 是唯一权威 —— 小程序 `coupon` 云函数直接读它。
 * 所以这里保存即生效，没有「发布」步骤（与轮播不同：轮播的编辑权威在 OS，需要同步）。
 *
 * 关键口径（必须留在页面上，避免运营误解）：
 *  1. 改面额/门槛/有效期只影响之后领到的券；已发出的券是领取时的快照，不受影响。
 *  2. 已发出的数量由云函数维护，这里只读。
 *  3. 停用只是停止新发放，已经发出去的券照常可用。
 */

const SOURCES = [
  { value: 'newcomer', label: '新人券' },
  { value: 'campaign', label: '活动券' },
  { value: 'repurchase', label: '首单复购券' },
  { value: 'share', label: '分享券' },
  { value: 'repurchase-code', label: '复购码券' },
  { value: 'manual', label: '后台手动发放' },
]

const inputClass = 'w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-budu-400'

const yuan = (cent) => (Number(cent || 0) / 100).toFixed(2).replace(/\.00$/, '')
const cents = (value) => Math.round(Number(value || 0) * 100)

const EMPTY_FORM = {
  id: '',
  name: '',
  faceYuan: '',
  thresholdYuan: '',
  validDays: '7',
  totalQty: '',
  perUserLimit: '1',
  source: 'newcomer',
  status: 'on',
  remark: '',
}

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-slate-600">{label}</span>
        {hint ? <span className="text-[11px] text-slate-400">{hint}</span> : null}
      </div>
      {children}
    </label>
  )
}

export default function CouponBoard() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api('/v2/online-catalog/coupon-templates')
      setRows(Array.isArray(res?.templates) ? res.templates : [])
    } catch (err) {
      setError(err.message || '券模板加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const stats = useMemo(() => {
    const on = rows.filter((row) => row.status === 'on')
    const issued = rows.reduce((sum, row) => sum + (Number(row.issuedQty) || 0), 0)
    return { total: rows.length, on: on.length, issued }
  }, [rows])

  const startCreate = () => {
    setForm(EMPTY_FORM)
    setError('')
    setNotice('')
    setOpen(true)
  }

  const startEdit = (row) => {
    setForm({
      id: row.id,
      name: row.name,
      faceYuan: yuan(row.faceCent),
      thresholdYuan: yuan(row.thresholdCent),
      validDays: String(row.validDays || 7),
      totalQty: row.totalQty === null || row.totalQty === undefined ? '' : String(row.totalQty),
      perUserLimit: String(row.perUserLimit || 1),
      source: row.source || 'newcomer',
      status: row.status === 'off' ? 'off' : 'on',
      remark: row.remark || '',
    })
    setError('')
    setNotice('')
    setOpen(true)
  }

  const save = async () => {
    if (!form.name.trim()) { setError('请填写券名称'); return }
    if (cents(form.faceYuan) <= 0) { setError('面额必须大于 0'); return }
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const payload = {
        name: form.name.trim(),
        faceCent: cents(form.faceYuan),
        thresholdCent: cents(form.thresholdYuan),
        validDays: Number(form.validDays),
        totalQty: form.totalQty === '' ? null : Number(form.totalQty),
        perUserLimit: Number(form.perUserLimit),
        source: form.source,
        status: form.status,
        remark: form.remark,
      }
      if (form.id) await api(`/v2/online-catalog/coupon-templates/${form.id}`, { method: 'PUT', body: JSON.stringify(payload) })
      else await api('/v2/online-catalog/coupon-templates', { method: 'POST', body: JSON.stringify(payload) })
      setOpen(false)
      setNotice('已保存，立即生效。已发出的券不受影响。')
      await load()
    } catch (err) {
      setError(err.message || '保存失败')
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (row) => {
    setBusy(true)
    setError('')
    try {
      await api(`/v2/online-catalog/coupon-templates/${row.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: row.name,
          faceCent: row.faceCent,
          thresholdCent: row.thresholdCent,
          validDays: row.validDays,
          totalQty: row.totalQty,
          perUserLimit: row.perUserLimit,
          source: row.source,
          remark: row.remark,
          status: row.status === 'on' ? 'off' : 'on',
        }),
      })
      setNotice(row.status === 'on' ? '已停用：不再发放，已发出的券仍可用。' : '已启用。')
      await load()
    } catch (err) {
      setError(err.message || '切换失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold text-slate-800">
            <BadgePercent className="h-4 w-4 text-budu-500" />
            优惠券
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            保存即生效，小程序券包与结算页直接读这份配置。改面额/门槛/时效只影响之后领到的券，
            <span className="text-slate-600">已发出的券按领取时的快照，不受影响</span>。
          </p>
        </div>
        <button
          type="button"
          onClick={startCreate}
          className="inline-flex items-center gap-1.5 rounded-xl bg-budu-500 px-3 py-2 text-sm font-medium text-white hover:bg-budu-600"
        >
          <Plus className="h-4 w-4" /> 新建券
        </button>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {[
          { label: '券模板', value: stats.total },
          { label: '启用中', value: stats.on },
          { label: '累计已发', value: stats.issued },
        ].map((item) => (
          <div key={item.label} className="rounded-xl border border-slate-200 bg-white px-3 py-2">
            <div className="text-[11px] text-slate-500">{item.label}</div>
            <div className="text-lg font-semibold text-slate-800">{item.value}</div>
          </div>
        ))}
      </div>

      {error ? <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-600">{error}</div> : null}
      {notice ? <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">{notice}</div> : null}

      {loading ? (
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-10 text-center text-sm text-slate-400">加载中…</div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-10 text-center">
          <div className="text-sm text-slate-500">还没有券模板</div>
          <div className="mt-1 text-xs text-slate-400">点右上角「新建券」开始配置新人券或复购券</div>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left font-medium">券名称</th>
                <th className="px-3 py-2 text-right font-medium">面额</th>
                <th className="px-3 py-2 text-right font-medium">门槛</th>
                <th className="px-3 py-2 text-right font-medium">有效期</th>
                <th className="px-3 py-2 text-right font-medium">已发 / 总量</th>
                <th className="px-3 py-2 text-center font-medium">状态</th>
                <th className="px-3 py-2 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => (
                <tr key={row.id} className="hover:bg-slate-50/60">
                  <td className="px-3 py-2">
                    <div className="font-medium text-slate-800">{row.name}</div>
                    <div className="text-[11px] text-slate-400">
                      {row.sourceLabel} · 每人限领 {row.perUserLimit} 张 · {row.id}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right font-medium text-budu-600">¥{yuan(row.faceCent)}</td>
                  <td className="px-3 py-2 text-right text-slate-600">{row.thresholdCent > 0 ? `满 ¥${yuan(row.thresholdCent)}` : '无门槛'}</td>
                  <td className="px-3 py-2 text-right text-slate-600">{row.validDays} 天</td>
                  <td className="px-3 py-2 text-right text-slate-600">
                    {row.issuedQty} / {row.totalQty === null ? '不限' : row.totalQty}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] ${row.status === 'on' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                      {row.status === 'on' ? '启用' : '停用'}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="inline-flex items-center gap-1">
                      <button type="button" onClick={() => startEdit(row)} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50">
                        <Pencil className="h-3 w-3" /> 编辑
                      </button>
                      <button type="button" onClick={() => toggle(row)} disabled={busy} className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50">
                        {row.status === 'on' ? '停用' : '启用'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-0 sm:items-center sm:p-6">
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <div className="text-base font-semibold text-slate-800">{form.id ? '编辑券模板' : '新建券'}</div>
                <div className="mt-1 text-[11px] text-slate-400">金额按元填写，保存时转成分。</div>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <Field label="券名称" hint="小程序券包显示的名字">
                  <input className={inputClass} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例如 新人首单券" />
                </Field>
              </div>
              <Field label="面额（元）">
                <input className={inputClass} inputMode="decimal" value={form.faceYuan} onChange={(e) => setForm({ ...form, faceYuan: e.target.value })} placeholder="5" />
              </Field>
              <Field label="使用门槛（元）" hint="0 = 无门槛">
                <input className={inputClass} inputMode="decimal" value={form.thresholdYuan} onChange={(e) => setForm({ ...form, thresholdYuan: e.target.value })} placeholder="0" />
              </Field>
              <Field label="有效期（天）" hint="领取后 N 天，到当天 23:59:59">
                <input className={inputClass} inputMode="numeric" value={form.validDays} onChange={(e) => setForm({ ...form, validDays: e.target.value })} />
              </Field>
              <Field label="每人限领（张）">
                <input className={inputClass} inputMode="numeric" value={form.perUserLimit} onChange={(e) => setForm({ ...form, perUserLimit: e.target.value })} />
              </Field>
              <Field label="发放总量" hint="留空 = 不限量">
                <input className={inputClass} inputMode="numeric" value={form.totalQty} onChange={(e) => setForm({ ...form, totalQty: e.target.value })} placeholder="不限" />
              </Field>
              <Field label="发放渠道">
                <select className={inputClass} value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })}>
                  {SOURCES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
                <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
                  新人券、活动券、手动发放会出现在顾客「可领取」列表；复购券、分享券、复购码由系统定向发放，不可自助领取。
                </p>
              </Field>
              <Field label="状态">
                <select className={inputClass} value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                  <option value="on">启用</option>
                  <option value="off">停用</option>
                </select>
              </Field>
              <div className="col-span-2">
                <Field label="备注" hint="仅内部可见">
                  <input className={inputClass} value={form.remark} onChange={(e) => setForm({ ...form, remark: e.target.value })} placeholder="例如 进店弹窗发放" />
                </Field>
              </div>
            </div>

            {error ? <div className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-600">{error}</div> : null}

            <div className="mt-5 flex items-center justify-end gap-2">
              <button type="button" onClick={() => setOpen(false)} className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50">取消</button>
              <button type="button" onClick={save} disabled={busy} className="rounded-xl bg-budu-500 px-4 py-2 text-sm font-medium text-white hover:bg-budu-600 disabled:opacity-60">
                {busy ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
