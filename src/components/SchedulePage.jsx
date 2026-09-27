import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  CalendarClock,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import { toPng } from 'html-to-image'
import { allStores, currentEmployeeDirectory } from '../utils/selectors'
import { api } from '../utils/api'
import BuduSuccessFeedback from './feedback/BuduSuccessFeedback'
import { addWeeks, getWeekDays, getWeekStart, isoWeek, todayStr, weekRangeLabel } from '../utils/schedule'
import { t } from '../utils/text'

const inputCls = 'input'

function weekFromRows(rows) {
  const nested = {}
  for (const row of rows || []) {
    nested[row.storeKey] = nested[row.storeKey] || {}
    nested[row.storeKey][row.date] = Array.isArray(row.shifts) ? row.shifts : []
  }
  return nested
}

export default function SchedulePage({ onBack, canEdit = true, user, registerNavigationGuard }) {
  // allStores 可能包含 BASE_STORES 与云端门店的重复 key，按 key 去重
  const stores = [...new Map(allStores().map((s) => [s.key, s])).values()]
  const [weekStart, setWeekStart] = useState(() => getWeekStart())
  // 默认「全部门店」：一次展示所有门店排班详情
  const [storeKey, setStoreKey] = useState('all')
  const [editingDate, setEditingDate] = useState(null)
  const [editingStore, setEditingStore] = useState('')
  const [editingIndex, setEditingIndex] = useState(null)
  const [draft, setDraft] = useState({ employeeId: '', time: '', note: '' })
  const [errorTip, setErrorTip] = useState('')
  const [exporting, setExporting] = useState(false)
  const [previewUrl, setPreviewUrl] = useState('')
  const [schedules, setSchedules] = useState({}) // 当前编辑 draft；只在最终保存时写 PostgreSQL
  const [baselineSchedules, setBaselineSchedules] = useState({})
  const [scheduleVersions, setScheduleVersions] = useState({})
  const [emptyVersion, setEmptyVersion] = useState('')
  const [dirtyStores, setDirtyStores] = useState([])
  const [discardOpen, setDiscardOpen] = useState(false)
  const [feedback, setFeedback] = useState(null)
  const [saving, setSaving] = useState(false)
  const exportRef = useRef(null)
  const dirtyRef = useRef(false)
  const pendingTransitionRef = useRef(null)

  const dirty = dirtyStores.length > 0

  const days = getWeekDays(weekStart)
  const today = todayStr()
  const storeInfo = stores.find((s) => s.key === storeKey)
  const staffOptions = currentEmployeeDirectory('all').sort((a, b) =>
    String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'),
  )

  // 从 PostgreSQL 加载当前周排班（唯一读权威）
  const loadWeek = useCallback(async (ws) => {
    try {
      const res = await api(`/v2/schedules?weekStart=${encodeURIComponent(ws)}`)
      const nested = weekFromRows(res.rows)
      setSchedules((prev) => ({ ...prev, [ws]: nested }))
      setBaselineSchedules((prev) => ({ ...prev, [ws]: structuredClone(nested) }))
      setScheduleVersions((prev) => ({ ...prev, [ws]: res.versions || {} }))
      setEmptyVersion(String(res.emptyVersion || ''))
      dirtyRef.current = false
      setDirtyStores([])
    } catch (e) {
      setErrorTip(e.message || t('排班加载失败'))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    loadWeek(weekStart)
  }, [weekStart, loadWeek])

  useEffect(() => {
    const onBeforeUnload = (event) => {
      if (!dirtyRef.current) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  const discardCurrentDraft = useCallback(() => {
    dirtyRef.current = false
    setSchedules((current) => ({
      ...current,
      [weekStart]: structuredClone(baselineSchedules[weekStart] || {}),
    }))
    setDirtyStores([])
    setErrorTip('')
  }, [baselineSchedules, weekStart])

  const requestTransition = useCallback((action) => {
    if (!dirtyRef.current) {
      return action?.()
    }
    pendingTransitionRef.current = action
    setDiscardOpen(true)
    return undefined
  }, [])

  useEffect(() => {
    registerNavigationGuard?.(requestTransition)
    return () => registerNavigationGuard?.(null)
  }, [registerNavigationGuard, requestTransition])

  const continueAfterDiscard = () => {
    const action = pendingTransitionRef.current
    pendingTransitionRef.current = null
    discardCurrentDraft()
    setDiscardOpen(false)
    action?.()
  }

  const closeEditor = () => {
    setEditingDate(null)
    setEditingStore('')
    setEditingIndex(null)
    setErrorTip('')
  }

  // 绑定员工（staffKey = storeKey::name）：本人当班名字高亮
  const myStaffKey = String((user && user.staffKey) || '')
  const myName = myStaffKey.includes('::') ? myStaffKey.split('::')[1] : ''
  const isMyShift = (shiftStoreKey, shift) => {
    const myEmployeeId = String((user && user.employeeId) || '')
    if (myEmployeeId && shift.employeeId) return myEmployeeId === shift.employeeId
    return Boolean(myName) && myStaffKey === `${shiftStoreKey}::${shift.staff}`
  }

  /** 单次把本轮所有门店修改原子写入 PostgreSQL；失败时保留 draft。 */
  const saveSchedule = async () => {
    if (!dirty || saving) return
    setSaving(true)
    setErrorTip('')
    try {
      const response = await api('/v2/schedules/batch', {
        method: 'PUT',
        body: JSON.stringify({
          weekStart,
          stores: dirtyStores.map((key) => ({
            storeKey: key,
            days: (schedules[weekStart] || {})[key] || {},
            version: (scheduleVersions[weekStart] || {})[key] || emptyVersion,
          })),
        }),
      })
      const savedWeek = { ...(schedules[weekStart] || {}) }
      for (const key of dirtyStores) delete savedWeek[key]
      Object.assign(savedWeek, weekFromRows(response.rows))
      setSchedules((current) => ({ ...current, [weekStart]: savedWeek }))
      setBaselineSchedules((current) => ({ ...current, [weekStart]: structuredClone(savedWeek) }))
      setScheduleVersions((current) => ({
        ...current,
        [weekStart]: { ...(current[weekStart] || {}), ...(response.versions || {}) },
      }))
      if (response.emptyVersion) setEmptyVersion(String(response.emptyVersion))
      dirtyRef.current = false
      setDirtyStores([])
      setFeedback({ title: t('排班已保存') })
    } catch (e) {
      setErrorTip(e.message || t('排班保存失败，请重试'))
    } finally {
      setSaving(false)
    }
  }

  const markStoreDirty = (store) => {
    dirtyRef.current = true
    setDirtyStores((current) => current.includes(store) ? current : [...current, store])
  }

  const weekShiftsOf = (store) => (schedules[weekStart] || {})[store] || {}

  const setWeekShifts = (store, date, shifts) => {
    setSchedules((current) => {
      const nextWeek = { ...(current[weekStart] || {}) }
      const nextStoreDays = { ...(nextWeek[store] || {}) }
      if (shifts.length > 0) {
        nextStoreDays[date] = shifts
        nextWeek[store] = nextStoreDays
      } else {
        delete nextStoreDays[date]
        if (Object.keys(nextStoreDays).length > 0) nextWeek[store] = nextStoreDays
        else delete nextWeek[store]
      }
      return { ...current, [weekStart]: nextWeek }
    })
    markStoreDirty(store)
  }

  const openEditor = (date, store, index = null) => {
    const shift = index === null ? null : (weekShiftsOf(store)[date] || [])[index]
    setEditingDate(date)
    setEditingStore(store)
    setEditingIndex(index)
    setDraft({
      employeeId: String(shift?.employeeId || ''),
      time: String(shift?.time || ''),
      note: String(shift?.note || ''),
    })
    setErrorTip('')
  }

  const confirmAdd = () => {
    const employee = staffOptions.find((row) => row.id === draft.employeeId)
    if (!employee) {
      setErrorTip(t('请选择有效员工'))
      return
    }
    const current = [...((((schedules[weekStart] || {})[editingStore] || {})[editingDate]) || [])]
    if (current.some((row, index) => index !== editingIndex && row.employeeId === employee.id)) {
      setErrorTip(t('该员工当天已有排班'))
      return
    }
    const nextShift = {
      employeeId: employee.id,
      staff: employee.name,
      time: draft.time.trim(),
      note: draft.note.trim(),
    }
    const shifts = editingIndex === null ? [...current, nextShift] : current.map((row, index) => index === editingIndex ? nextShift : row)
    setWeekShifts(editingStore, editingDate, shifts)
    closeEditor()
  }

  const removeShift = (store, date, index) => {
    const shifts = (weekShiftsOf(store)[date] || []).filter((_, i) => i !== index)
    setWeekShifts(store, date, shifts)
  }

  /** 一键导出当前页面排班为图片（整周表完整宽度，不含增删按钮） */
  const exportImage = async () => {
    const node = exportRef.current
    if (!node || exporting) return
    setExporting(true)
    // 临时加宽到整周表完整宽度，避免窄屏截图裁掉右侧列
    const prevWidth = node.style.width
    const wide = Math.max(980, ...[...node.querySelectorAll('.card')].map((c) => c.scrollWidth || 0))
    node.style.width = `${wide}px`
    try {
      await new Promise((resolve) => setTimeout(resolve, 30))
      const dataUrl = await toPng(node, {
        pixelRatio: 2,
        cacheBust: true,
        backgroundColor: '#ffffff',
        filter: (el) => !(el instanceof HTMLElement && el.dataset.exportIgnore === '1'),
      })
      const storeLabel = storeKey === 'all' ? t('全部门店') : storeInfo ? storeInfo.name : storeKey
      const fileName = `${t('排班表')}-${weekRangeLabel(weekStart).replace(/ /g, '')}-${storeLabel}.png`
      const isTouch = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || navigator.maxTouchPoints > 1
      if (isTouch) {
        try {
          const blob = await (await fetch(dataUrl)).blob()
          const file = new File([blob], fileName, { type: 'image/png' })
          if (navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], title: t('排班表') })
            return
          }
        } catch {
          /* 用户取消或系统不支持，继续走长按保存 */
        }
        setPreviewUrl(dataUrl)
        return
      }
      const a = document.createElement('a')
      a.href = dataUrl
      a.download = fileName
      a.click()
    } catch {
      setErrorTip(t('导出失败，请重试或手动截图'))
    } finally {
      node.style.width = prevWidth
      setExporting(false)
    }
  }

  /** 单个门店的周排班表（全门店视图与单店视图共用） */
  const renderWeekTable = (store) => {
    const weekData = weekShiftsOf(store)
    const totalShifts = days.reduce((s, d) => s + (weekData[d.date] || []).length, 0)
    return (
      <div key={store} className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-5 py-4">
          <h3 className="flex items-center gap-2 text-[15px] font-bold text-slate-800">
            <CalendarClock className="h-4 w-4 text-budu-500" />
            {t('周排班表')}
          </h3>
          <span className="rounded-lg bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-500">
            {weekRangeLabel(weekStart)} · {stores.find((x) => x.key === store)?.name || store}
          </span>
          <span className="rounded-lg bg-budu-50 px-2 py-0.5 text-xs font-semibold text-budu-600">
            {t('共 {n} 个班次', { n: totalShifts })}
          </span>
          {!canEdit && (
            <span className="ml-auto rounded-lg bg-slate-50 px-2 py-0.5 text-[11px] text-slate-400">
              {t('只读模式')}
            </span>
          )}
        </div>

        <div className="overflow-x-auto">
          <div className="grid min-w-[980px] grid-cols-7 divide-x divide-slate-100">
            {days.map((d) => {
              const shifts = weekData[d.date] || []
              const isToday = d.date === today
              return (
                <div key={d.date} className={`flex min-h-[280px] flex-col ${isToday ? 'bg-budu-50/50' : ''}`}>
                  <div className={`border-b px-3 py-3 text-center ${isToday ? 'border-budu-100' : 'border-slate-100'}`}>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{t(d.label)}</p>
                    <p className={`mt-0.5 text-lg font-bold ${isToday ? 'text-budu-600' : 'text-slate-700'}`}>{d.day}</p>
                    {shifts.length > 0 && (
                      <span className="mt-1 inline-block rounded-md bg-budu-100 px-1.5 py-0.5 text-[10px] font-bold text-budu-600">
                        {t('{n} 人', { n: shifts.length })}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-1 flex-col gap-2 p-2.5">
                    {shifts.map((s, i) => {
                      const mine = isMyShift(store, s)
                      return (
                        <div
                          key={i}
                          className={`rounded-xl p-2 shadow-sm ring-1 ${
                            mine ? 'bg-amber-50 ring-amber-300' : 'bg-white ring-slate-100'
                          }`}
                        >
                          <div className="flex items-start justify-between gap-1">
                            <div className="min-w-0">
                              <p className={`truncate text-[13px] font-bold ${mine ? 'text-amber-700' : 'text-slate-700'}`}>
                                {s.staff}
                                {mine && (
                                  <span className="ml-1.5 rounded bg-amber-500 px-1.5 py-0.5 text-[9px] font-bold text-white">
                                    {t('我')}
                                  </span>
                                )}
                              </p>
                              {s.time && <p className="mt-0.5 text-[11px] font-semibold text-budu-500">{s.time}</p>}
                              {!s.employeeId && <p className="mt-0.5 text-[10px] font-semibold text-amber-600">{t('需重新选择员工')}</p>}
                            </div>
                            {canEdit && (
                              <div className="flex shrink-0 items-center" data-export-ignore="1">
                                <button
                                  onClick={() => openEditor(d.date, store, i)}
                                  className="rounded-lg p-1 text-slate-300 transition hover:bg-budu-50 hover:text-budu-500"
                                  aria-label={t('编辑')}
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  onClick={() => removeShift(store, d.date, i)}
                                  className="rounded-lg p-1 text-slate-300 transition hover:bg-rose-50 hover:text-rose-500"
                                  aria-label={t('删除')}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            )}
                          </div>
                          {s.note && <p className="mt-1 truncate text-[10px] text-slate-400">{s.note}</p>}
                        </div>
                      )
                    })}
                    {shifts.length === 0 && (
                      <p className="grid flex-1 place-items-center pb-4 text-[11px] text-slate-300">{t('暂无排班')}</p>
                    )}
                    {canEdit && (
                      <button
                        data-export-ignore="1"
                        onClick={() => openEditor(d.date, store)}
                        className="mt-auto flex items-center justify-center gap-1 rounded-xl border border-dashed border-budu-200 py-2 text-xs font-semibold text-budu-500 transition hover:bg-budu-50"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        {t('添加排班')}
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* 页面头部 */}
      <div className="flex flex-wrap items-center gap-4">
        <button
          onClick={() => requestTransition(onBack)}
          className="flex items-center gap-1.5 rounded-2xl bg-white px-3.5 py-2.5 text-sm font-medium text-slate-500 shadow-card transition hover:text-budu-600"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('返回首页')}
        </button>
        <div>
          <h2 className="text-xl font-bold text-slate-800">{t('门店排班')}</h2>
          <p className="mt-0.5 text-[13px] text-slate-400">
            {t('按周为各个门店安排值班人员与班次，保存后所有登录账号实时同步')}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {canEdit && (
            <button
              data-testid="schedule-save"
              onClick={saveSchedule}
              disabled={!dirty || saving}
              className="hidden items-center gap-1.5 rounded-xl bg-budu-500 px-3 py-2 text-xs font-semibold text-white shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 lg:flex"
            >
              <Check className="h-3.5 w-3.5" />
              {saving ? t('保存中…') : t('保存排班')}
            </button>
          )}
          <button
            onClick={exportImage}
            disabled={exporting}
            className="flex items-center gap-1.5 rounded-xl bg-slate-800 px-3 py-2 text-xs font-semibold text-white transition hover:bg-slate-700 disabled:opacity-60"
          >
            <Download className="h-3.5 w-3.5" />
            {exporting ? t('导出中…') : t('导出图片')}
          </button>
          {dirty && (
            <span data-testid="schedule-dirty" className="rounded-lg bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-600">
              {t('有未保存修改')}
            </span>
          )}
          <span className="rounded-lg bg-budu-50 px-2.5 py-1 text-xs font-semibold text-budu-600">
            {t('共 {n} 个班次', {
              n: days.reduce((sum, d) => {
                const week = schedules[weekStart] || {}
                return sum + Object.values(week).reduce((s2, storeDays) => s2 + ((storeDays && storeDays[d.date]) || []).length, 0)
              }, 0),
            })}
          </span>
        </div>
      </div>

      {errorTip && !editingDate && (
        <div role="alert" className="rounded-xl border border-rose-100 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-600">
          {errorTip}
        </div>
      )}

      {/* 周切换 + 门店选择 */}
      <div className="card flex flex-wrap items-center gap-3 p-4">
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => requestTransition(() => setWeekStart(addWeeks(weekStart, -1)))}
            className="grid h-9 w-9 place-items-center rounded-xl bg-slate-50 text-slate-500 transition hover:bg-budu-50 hover:text-budu-600"
            aria-label={t('上一周')}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            onClick={() => requestTransition(() => setWeekStart(getWeekStart()))}
            className="rounded-xl bg-budu-50 px-3 py-2 text-xs font-semibold text-budu-600 transition hover:bg-budu-100"
          >
            {t('本周')}
          </button>
          <button
            onClick={() => requestTransition(() => setWeekStart(addWeeks(weekStart, 1)))}
            className="grid h-9 w-9 place-items-center rounded-xl bg-slate-50 text-slate-500 transition hover:bg-budu-50 hover:text-budu-600"
            aria-label={t('下一周')}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>

        <div className="min-w-0">
          <p className="text-sm font-bold text-slate-700">{weekRangeLabel(weekStart)}</p>
          <p className="text-[11px] font-medium text-slate-400">
            {t('第 {n} 周', { n: isoWeek(weekStart) })} · {storeKey === 'all' ? t('全部门店') : storeInfo ? storeInfo.name : ''}
          </p>
        </div>

        <div className="ml-auto flex flex-wrap gap-1.5">
          <button
            onClick={() => requestTransition(() => setStoreKey('all'))}
            className={`rounded-xl px-3 py-2 text-[13px] font-semibold transition ${
              storeKey === 'all'
                ? 'bg-budu-500 text-white shadow-sm'
                : 'bg-slate-50 text-slate-500 hover:bg-budu-50 hover:text-budu-600'
            }`}
          >
            {t('全部门店')}
          </button>
          {stores.map((s) => (
            <button
              key={s.key}
              onClick={() => requestTransition(() => setStoreKey(s.key))}
              className={`rounded-xl px-3 py-2 text-[13px] font-semibold transition ${
                s.key === storeKey
                  ? 'bg-budu-500 text-white shadow-sm'
                  : 'bg-slate-50 text-slate-500 hover:bg-budu-50 hover:text-budu-600'
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>
      </div>

      {/* 排班表：全部门店视图 或 单店视图 */}
      <div ref={exportRef}>
        {storeKey === 'all' ? (
          <div className="space-y-5">{stores.map((s) => renderWeekTable(s.key))}</div>
        ) : (
          renderWeekTable(storeKey)
        )}
      </div>

      <p className="text-center text-[11px] text-slate-300">
        {t('可连续添加、编辑或删除多个班次；点击保存排班后一次同步到云端')}
      </p>

      {canEdit && (
        <div className="sticky bottom-[calc(5.25rem+env(safe-area-inset-bottom))] z-30 rounded-2xl border border-white/80 bg-white/95 p-2 shadow-lg backdrop-blur lg:hidden">
          <button
            data-testid="schedule-save-mobile"
            onClick={saveSchedule}
            disabled={!dirty || saving}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-budu-500 px-4 py-3 text-sm font-bold text-white shadow-sm transition active:scale-[0.99] disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
          >
            <Check className="h-4 w-4" />
            {saving ? t('保存中…') : dirty ? t('保存排班') : t('排班已保存')}
          </button>
        </div>
      )}

      {/* 卡皮巴拉提交成功动画 */}
      {feedback && (
        <BuduSuccessFeedback
          open={!!feedback}
          title={feedback.title}
          description={feedback.description}
          onClose={() => setFeedback(null)}
        />
      )}

      {/* 导出图片预览（移动端不支持分享/下载时，长按保存到相册） */}
      {previewUrl && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-slate-900/70 p-4 backdrop-blur-sm"
          onClick={() => setPreviewUrl('')}
        >
          <div className="w-full max-w-xl overflow-hidden rounded-2xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
              <p className="text-sm font-bold text-slate-700">{t('排班表图片')}</p>
              <button
                onClick={() => setPreviewUrl('')}
                className="rounded-xl p-1.5 text-slate-400 transition hover:bg-slate-50 hover:text-slate-600"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="max-h-[75vh] overflow-auto bg-slate-100 p-3">
              <img src={previewUrl} alt={t('排班表图片')} className="w-full rounded-lg shadow-sm" />
            </div>
            <p className="px-4 py-3 text-center text-[11px] text-slate-400">{t('长按图片可保存到相册')}</p>
          </div>
        </div>
      )}

      {discardOpen && (
        <div
          data-testid="schedule-unsaved-dialog"
          className="fixed inset-0 z-[60] grid place-items-center bg-slate-900/40 p-4 backdrop-blur-sm"
          onClick={() => {
            pendingTransitionRef.current = null
            setDiscardOpen(false)
          }}
        >
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl" onClick={(event) => event.stopPropagation()}>
            <h3 className="text-base font-bold text-slate-800">{t('排班尚未保存')}</h3>
            <p className="mt-2 text-sm leading-6 text-slate-500">
              {t('离开后本次添加、编辑和删除将不会保存。')}
            </p>
            <div className="mt-5 flex gap-2">
              <button
                onClick={() => {
                  pendingTransitionRef.current = null
                  setDiscardOpen(false)
                }}
                className="flex-1 rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-600 transition hover:bg-slate-200"
              >
                {t('继续编辑')}
              </button>
              <button
                onClick={continueAfterDiscard}
                className="flex-1 rounded-xl bg-rose-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-rose-600"
              >
                {t('放弃修改')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 添加/编辑排班弹窗 */}
      {editingDate && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 p-4 backdrop-blur-sm"
          onClick={closeEditor}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-white p-5 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-slate-800">
                  {editingIndex === null ? t('添加员工排班') : t('编辑员工排班')}
                </h3>
                <p className="mt-0.5 text-xs text-slate-400">
                  {weekRangeLabel(weekStart)} · {stores.find((x) => x.key === editingStore)?.name || ''} · {editingDate}
                </p>
              </div>
              <button
                onClick={closeEditor}
                className="rounded-xl p-2 text-slate-400 transition hover:bg-slate-50 hover:text-slate-600"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <span className="mb-1.5 block text-xs font-semibold text-slate-500">{t('员工')}</span>
                <select
                  value={draft.employeeId}
                  onChange={(e) => setDraft((s) => ({ ...s, employeeId: e.target.value }))}
                  className={inputCls}
                  autoFocus
                >
                  <option value="">{t('请选择员工')}</option>
                  {staffOptions.map((employee) => (
                    <option key={employee.id} value={employee.id}>
                      {employee.name} · {employee.employeeNo || employee.id} · {stores.find((store) => store.key === employee.storeKey)?.name || employee.storeKey}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <span className="mb-1.5 block text-xs font-semibold text-slate-500">{t('班次时间')}</span>
                <select
                  value={draft.time}
                  onChange={(e) => setDraft((s) => ({ ...s, time: e.target.value }))}
                  className={inputCls}
                >
                  <option value="">{t('选择班次')}</option>
                  <option value="早班">{t('早班')}</option>
                  <option value="晚班">{t('晚班')}</option>
                  <option value="通班">{t('通班')}</option>
                </select>
              </div>

              <div>
                <span className="mb-1.5 block text-xs font-semibold text-slate-500">{t('备注')}</span>
                <input
                  value={draft.note}
                  onChange={(e) => setDraft((s) => ({ ...s, note: e.target.value }))}
                  placeholder={t('选填，例如 主理/备货')}
                  className={inputCls}
                />
              </div>

              {errorTip && <p className="text-xs font-medium text-rose-500">{errorTip}</p>}
            </div>

            <div className="mt-5 flex gap-2">
              <button
                onClick={closeEditor}
                className="flex-1 rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-500 transition hover:bg-slate-200"
              >
                {t('取消')}
              </button>
              <button
                onClick={confirmAdd}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-budu-500 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-90"
              >
                <Check className="h-4 w-4" />
                {editingIndex === null ? t('确认添加') : t('确认修改')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
