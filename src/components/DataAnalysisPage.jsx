import { useRef, useState } from 'react'
import {
  ArrowLeft,
  CheckCircle2,
  Database,
  FileSpreadsheet,
  Loader2,
  Trash2,
  UploadCloud,
} from 'lucide-react'
import { api } from '../utils/api'
import { getAnalysis, loadUserData } from '../utils/userData'
import { useI18n } from '../i18n'

export default function DataAnalysisPage({ onBack }) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [summary, setSummary] = useState(null)
  const [version, setVersion] = useState(0)
  const inputRef = useRef(null)
  const analysis = getAnalysis()
  const hasAnalysis = (analysis.months && analysis.months.length > 0) || Object.keys(analysis.daily || {}).length > 0 || Object.keys(analysis.products || {}).length > 0 || (analysis.employees && analysis.employees.length > 0)

  const handleFile = async (e) => {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!file) return
    setBusy(true)
    setError('')
    setMessage('')
    setSummary(null)
    try {
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
        reader.onerror = () => reject(new Error(t('读取文件失败')))
        reader.readAsDataURL(file)
      })
      const data = await api('/analysis/upload', {
        method: 'POST',
        body: JSON.stringify({ name: file.name, base64 }),
      })
      setSummary(data.summary)
      setMessage(t('分析完成，各模块数据已更新'))
      await loadUserData()
      setVersion((v) => v + 1)
    } catch (err) {
      setError(t(err.message))
    } finally {
      setBusy(false)
    }
  }

  const clear = async () => {
    if (!window.confirm(t('确定清除所有上传的分析数据吗？'))) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await api('/analysis', { method: 'DELETE' })
      await loadUserData()
      setVersion((v) => v + 1)
      setMessage(t('已清除上传的分析数据'))
    } catch (err) {
      setError(t(err.message))
    } finally {
      setBusy(false)
    }
  }

  const dailyRows = Object.values(analysis.daily || {}).reduce(
    (s, stores) => s + Object.values(stores).reduce((a, rows) => a + rows.length, 0),
    0,
  )
  const productCount = Object.values(analysis.products || {}).reduce(
    (s, stores) => s + Object.values(stores).reduce((a, list) => a + list.length, 0),
    0,
  )
  const employeeCount = (analysis.employees || []).length

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
            <Database className="h-5 w-5 text-grape-500" />
            {t('数据分析')}
          </h2>
          <p className="mt-0.5 text-[13px] text-slate-400">{t('上传门店报表，系统自动解析并匹配到各数据模块')}</p>
        </div>
      </div>

      {/* 上传入口 */}
      <div className="card p-6">
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          className="hidden"
          onChange={handleFile}
          disabled={busy}
        />
        <button
          onClick={() => inputRef.current && inputRef.current.click()}
          disabled={busy}
          className="flex w-full flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-budu-200 bg-budu-50/40 px-6 py-10 transition hover:border-budu-400 hover:bg-budu-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? (
            <Loader2 className="h-8 w-8 animate-spin text-budu-400" />
          ) : (
            <UploadCloud className="h-8 w-8 text-budu-400" />
          )}
          <span className="text-sm font-semibold text-budu-600">
            {busy ? t('正在分析…') : t('上传报表文件')}
          </span>
          <span className="text-xs text-slate-400">
            {t('支持 .xlsx / .xls / .csv，可上传月度营业额、菜品明细、薪资表')}
          </span>
        </button>

        {message && (
          <p className="mt-4 flex items-center gap-1.5 text-xs font-medium text-emerald-500">
            <CheckCircle2 className="h-4 w-4" />
            {message}
          </p>
        )}
        {error && <p className="mt-4 text-xs font-medium text-rose-500">{error}</p>}

        {summary && (
          <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <div className="rounded-xl bg-budu-50/70 px-4 py-3">
              <p className="text-[10px] font-semibold text-budu-500">{t('覆盖月份')}</p>
              <p className="mt-0.5 text-sm font-bold text-slate-700">{summary.months.length}</p>
            </div>
            <div className="rounded-xl bg-grape-50/70 px-4 py-3">
              <p className="text-[10px] font-semibold text-grape-500">{t('营业记录')}</p>
              <p className="mt-0.5 text-sm font-bold text-slate-700">{summary.dailyRows}</p>
            </div>
            <div className="rounded-xl bg-amber-50/70 px-4 py-3">
              <p className="text-[10px] font-semibold text-amber-600">{t('菜品数据')}</p>
              <p className="mt-0.5 text-sm font-bold text-slate-700">{summary.productCount}</p>
            </div>
            <div className="rounded-xl bg-emerald-50/70 px-4 py-3">
              <p className="text-[10px] font-semibold text-emerald-600">{t('员工数据')}</p>
              <p className="mt-0.5 text-sm font-bold text-slate-700">{summary.employeeCount}</p>
            </div>
          </div>
        )}
      </div>

      {/* 当前分析数据 */}
      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-5 py-4">
          <h3 className="flex items-center gap-2 text-[15px] font-bold text-slate-800">
            <FileSpreadsheet className="h-4 w-4 text-budu-500" />
            {t('当前分析数据')}
          </h3>
          {hasAnalysis && (
            <button
              onClick={clear}
              disabled={busy}
              className="ml-auto inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-rose-400 transition hover:bg-rose-50 hover:text-rose-500"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t('清除上传数据')}
            </button>
          )}
        </div>

        {hasAnalysis ? (
          <div className="space-y-4 px-5 py-5">
            <div className="flex flex-wrap gap-2">
              {(analysis.months || []).map((m) => (
                <span key={m} className="rounded-lg bg-budu-50 px-2.5 py-1 text-xs font-semibold text-budu-600">
                  {m}
                </span>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs text-slate-500 sm:grid-cols-4">
              <div className="rounded-xl bg-slate-50/80 px-4 py-3">
                <p className="font-semibold text-slate-400">{t('营业记录')}</p>
                <p className="mt-1 text-base font-bold text-slate-700">{dailyRows}</p>
              </div>
              <div className="rounded-xl bg-slate-50/80 px-4 py-3">
                <p className="font-semibold text-slate-400">{t('菜品数据')}</p>
                <p className="mt-1 text-base font-bold text-slate-700">{productCount}</p>
              </div>
              <div className="rounded-xl bg-slate-50/80 px-4 py-3">
                <p className="font-semibold text-slate-400">{t('员工数据')}</p>
                <p className="mt-1 text-base font-bold text-slate-700">{employeeCount}</p>
              </div>
              <div className="rounded-xl bg-slate-50/80 px-4 py-3">
                <p className="font-semibold text-slate-400">{t('来源文件')}</p>
                <p className="mt-1 line-clamp-2 break-all text-[11px] font-semibold text-slate-600">
                  {(analysis.sourceFiles || []).join('、') || '—'}
                </p>
              </div>
            </div>
            <div className="rounded-xl border border-budu-100 bg-budu-50/40 px-4 py-3 text-xs text-slate-500">
              <p className="font-semibold text-budu-600">{t('自动匹配模块')}</p>
              <p className="mt-1">{t('首页 KPI、门店排行、营业额趋势、渠道构成、商品销售、员工绩效、人员管理')}</p>
            </div>
          </div>
        ) : (
          <div className="grid place-items-center px-5 py-12 text-sm text-slate-300">
            {t('尚未上传分析数据，当前展示内置报表')}
          </div>
        )}
      </div>
    </div>
  )
}
