import { useEffect, useState } from 'react'
import { api } from '../utils/api'

const todayShanghai = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const iso = (date) => date.toISOString().slice(0, 10)
function previousWeek() {
  const today = new Date(`${todayShanghai()}T00:00:00.000Z`)
  const monday = new Date(today.getTime() - ((today.getUTCDay() + 6) % 7) * 86400000)
  return { periodStart: iso(new Date(monday.getTime() - 7 * 86400000)), periodEnd: iso(new Date(monday.getTime() - 86400000)) }
}
function previousMonth() {
  const today = new Date(`${todayShanghai()}T00:00:00.000Z`)
  return { periodStart: iso(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1))), periodEnd: iso(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0))) }
}

export default function PayrollAuditSchedulerCenter() {
  const [rows, setRows] = useState([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [emailConfigured, setEmailConfigured] = useState(false)
  const [reportType, setReportType] = useState('WEEKLY_PART_TIME')
  const initial = previousWeek()
  const [periodStart, setPeriodStart] = useState(initial.periodStart)
  const [periodEnd, setPeriodEnd] = useState(initial.periodEnd)
  const load = () => api('/v2/payroll-audits').then((result) => { setRows(result.rows || []); setEmailConfigured(result.emailConfigured === true) }).catch((error) => setMessage(error.message))
  useEffect(() => { void load() }, [])
  const choose = (type) => {
    const period = type === 'WEEKLY_PART_TIME' ? previousWeek() : previousMonth()
    setReportType(type); setPeriodStart(period.periodStart); setPeriodEnd(period.periodEnd)
  }
  const run = async (options = {}) => {
    setBusy(true); setMessage('')
    try {
      const result = await api('/v2/payroll-audits/run', { method: 'POST', body: JSON.stringify({ reportType, periodStart, periodEnd, dryRun: options.dryRun === true, testEmail: options.testEmail === true }) })
      setMessage(result?.job?.emailStatus === 'FAILED' ? `邮件发送失败：${result.job.lastErrorCode}` : options.testEmail ? '测试邮件已发送' : options.dryRun ? '只读审查报告已生成，未发送邮件' : '审查任务已执行')
      await load()
    } catch (error) { setMessage(error.message) } finally { setBusy(false) }
  }
  const resend = async (jobKey) => {
    setBusy(true); setMessage('')
    try { await api('/v2/payroll-audits/resend', { method: 'POST', body: JSON.stringify({ jobKey }) }); setMessage('重发操作已记录'); await load() }
    catch (error) { setMessage(error.message) } finally { setBusy(false) }
  }
  return <div className="space-y-4">
    <section className="rounded-2xl border border-slate-200 bg-white p-4">
      <h3 className="font-bold text-slate-800">手动薪酬审查</h3>
      <p className="mt-1 text-xs leading-5 text-slate-500">复用正式只读审查引擎。DRY RUN 不发送邮件；测试邮件带 [TEST] 标记且不占用正式周期幂等记录。</p>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <button type="button" className={`min-h-11 rounded-xl border px-3 text-sm ${reportType === 'WEEKLY_PART_TIME' ? 'border-budu-300 bg-budu-50' : 'border-slate-200'}`} onClick={() => choose('WEEKLY_PART_TIME')}>兼职上一周</button>
        <button type="button" className={`min-h-11 rounded-xl border px-3 text-sm ${reportType === 'MONTHLY_FULL_TIME' ? 'border-budu-300 bg-budu-50' : 'border-slate-200'}`} onClick={() => choose('MONTHLY_FULL_TIME')}>全职上一月</button>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2"><input aria-label="审查开始日期" type="date" className="input min-h-11" value={periodStart} onChange={(event) => setPeriodStart(event.target.value)} /><input aria-label="审查结束日期" type="date" className="input min-h-11" value={periodEnd} onChange={(event) => setPeriodEnd(event.target.value)} /></div>
      <div className="mt-3 flex flex-wrap gap-2"><button type="button" disabled={busy} className="btn-secondary min-h-11" onClick={() => void run({ dryRun: true })}>生成 DRY RUN</button><button type="button" disabled={busy || !emailConfigured} className="btn-secondary min-h-11 disabled:opacity-40" onClick={() => void run({ testEmail: true })}>发送 [TEST]</button></div>
      {!emailConfigured && <p className="mt-2 text-xs text-amber-700">Gmail 发送凭据尚未配置；可先生成 DRY RUN，测试邮件和定时器暂不启用。</p>}
      {message && <p className="mt-3 rounded-xl bg-slate-50 p-3 text-xs text-slate-600">{message}</p>}
    </section>
    <section className="rounded-2xl border border-slate-200 bg-white p-4"><h3 className="font-bold text-slate-800">审查历史</h3><div className="mt-3 space-y-2">{rows.length === 0 && <p className="text-sm text-slate-400">暂无服务器审查记录</p>}{rows.map((row) => <article key={row.jobKey} className="rounded-xl bg-slate-50 p-3 text-xs leading-5"><div className="flex items-start justify-between gap-2"><div><p className="font-semibold text-slate-800">{row.reportType === 'WEEKLY_PART_TIME' ? '兼职周审' : '全职月审'} · {row.periodStart} ～ {row.periodEnd}</p><p className="text-slate-500">{row.runStatus} · 异常 {row.anomalyCount} · 邮件 {row.emailStatus} · 尝试 {row.retryCount}</p></div>{row.artifacts && <button type="button" disabled={busy || !emailConfigured} className="min-h-10 shrink-0 rounded-lg border border-slate-200 bg-white px-3 disabled:opacity-40" onClick={() => void resend(row.jobKey)}>重发</button>}</div></article>)}</div></section>
    <p className="px-1 text-xs leading-5 text-amber-700">当前 Employee.employmentType 没有有效期历史。历史周期报告会明确标记 REVIEW_REQUIRED，不会猜测员工当时的用工类型。</p>
  </div>
}
