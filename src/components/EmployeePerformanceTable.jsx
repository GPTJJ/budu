import { ChevronRight } from 'lucide-react'
import Card from './Card'
import { employeeList, entryEmployeePerformance, storeName } from '../utils/selectors'
import { formatMoney, rankStyle } from '../utils/format'
import { useI18n } from '../i18n'
import { usePublicMode, useStorePrivacy } from '../visibility'

const AVATAR_GRADIENTS = [
  'from-budu-400 to-rose-400',
  'from-grape-400 to-indigo-400',
  'from-amber-400 to-orange-400',
  'from-emerald-400 to-teal-400',
  'from-sky-400 to-cyan-400',
]

function roiStyle(roi) {
  if (roi >= 12) return 'bg-emerald-50 text-emerald-600'
  if (roi >= 8) return 'bg-grape-50 text-grape-600'
  return 'bg-amber-50 text-amber-600'
}

export default function EmployeePerformanceTable({ store, month }) {
  const { t } = useI18n()
  const isPublic = usePublicMode()
  const isStore = useStorePrivacy()
  const hidePersonal = isStore
  const hideBusiness = isStore
  const entryRows = entryEmployeePerformance(store, month)
  const hasEntryData = entryRows.length > 0
  const list = (hasEntryData ? entryRows : employeeList(store)).slice(0, 5)

  return (
    <Card
      title={t('员工绩效 TOP5')}
      subtitle={
        hasEntryData
          ? t('根据门店业绩录入实时分析')
          : t('薪资表 2026.27-31 周 · {store}', { store: storeName(store) })
      }
      action={
        !isPublic && (
        <button className="flex items-center gap-0.5 text-xs font-medium text-budu-500 transition hover:text-budu-600">
          {t('查看全部')}
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
        )
      }
    >
      {isPublic ? (
        <div className="grid h-48 place-items-center text-xs text-slate-300">
          {t('对外展示模式 · 数据已隐藏')}
        </div>
      ) : (
        <div className="-mx-2 overflow-x-auto">
        <table className="w-full min-w-[520px] text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-left text-[11px] font-medium uppercase tracking-wider text-slate-400">
              <th className="pb-3 pl-2">{t('排名')}</th>
              <th className="pb-3">{t('员工')}</th>
              <th className="pb-3 text-right">{t('当班营业额')}</th>
              <th className="pb-3 text-right">{t('工资')}</th>
              <th className="pb-3 text-right">{t('ROI')}</th>
              <th className="pb-3 pr-2 text-right">{t('工时')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {list.map((row, i) => (
              <tr key={row.name} className="group transition-colors hover:bg-grape-50/40">
                <td className="py-3 pl-2">
                  <span
                    className={`grid h-6 w-6 place-items-center rounded-lg text-[11px] font-bold text-white ${rankStyle(i)}`}
                  >
                    {i + 1}
                  </span>
                </td>
                <td className="py-3">
                  <div className="flex items-center gap-2.5">
                    <span
                      className={`grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br text-xs font-bold text-white ${AVATAR_GRADIENTS[i % AVATAR_GRADIENTS.length]}`}
                    >
                      {row.name[0]}
                    </span>
                    <div className="leading-tight">
                      <p className="font-semibold text-slate-700 group-hover:text-budu-600">{row.name}</p>
                      <p className="mt-0.5 text-[11px] text-slate-400">
                        {row.storeName} · {t('出勤 {days} 天', { days: row.workedDays })}
                      </p>
                    </div>
                  </div>
                </td>
                <td className="py-3 text-right font-semibold tabular-nums text-slate-700">
                  {hideBusiness ? '•••' : `¥${formatMoney(row.workedRevenue)}`}
                </td>
                <td className="py-3 text-right text-xs tabular-nums text-slate-500">
                  {hidePersonal ? '•••' : hasEntryData && !row.salary ? '—' : `¥${formatMoney(row.salary)}`}
                </td>
                <td className="py-3 text-right">
                  <span className={`chip ${roiStyle(row.roi)}`}>
                    {hidePersonal ? '•••' : hasEntryData && !row.salary ? '—' : `${row.roi.toFixed(1)}x`}
                  </span>
                </td>
                <td className="py-3 pr-2 text-right text-xs tabular-nums text-slate-500">
                  {hidePersonal ? '•••' : hasEntryData && !row.hours ? '—' : `${Math.round(row.hours)}h`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
      <p className="mt-3 text-[11px] text-slate-300">
        {hasEntryData
          ? t('当班营业额按值班人数均摊；工资/提成 = 基础时薪×工时 + 业绩阶梯提成（按录入自动计算）')
          : t('当班营业额 = 出勤日门店营业额合计；ROI = 当班营业额 / 工资')}
      </p>
    </Card>
  )
}
