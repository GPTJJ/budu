import { useState } from 'react'
import { ChevronDown, ChevronUp, CircleDollarSign } from 'lucide-react'
import { formatMoney } from '../../utils/format'

const HOURS_SOURCE_LABELS = {
  ACTUAL_HOURS: '实际考勤工时',
  LEGACY_PAYROLL_HOURS: '历史计薪工时（无考勤事实）',
  LEGACY_DUTY_HOURS: '历史兼容计薪工时',
  ADJUSTMENT_ONLY: '无考勤，仅工资调整',
}

const DAY_POLICY_LABELS = {
  WORKDAY_POLICY: '工作日计薪规则',
  HOLIDAY_POLICY: '周末/节假日计薪规则',
}

function money(value) {
  if (value == null) return '—'
  return `¥${formatMoney(value)}`
}

function rate(value) {
  if (value == null) return '—'
  return `¥${formatMoney(value)}/h`
}

function hours(value) {
  if (value == null) return '—'
  return `${Number(value)}h`
}

function signedMoney(value) {
  if (value == null) return '—'
  const amount = Number(value) || 0
  return `${amount >= 0 ? '+' : '-'}¥${formatMoney(Math.abs(amount))}`
}

function dateLabel(date) {
  const value = String(date || '')
  const parsed = new Date(`${value}T00:00:00`)
  const weekday = Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleDateString('zh-CN', { weekday: 'short' })
  const match = value.match(/^\d{4}-(\d{2})-(\d{2})$/)
  return match ? `${Number(match[1])}月${Number(match[2])}日 ${weekday}` : value
}

function DetailRow({ label, value, strong = false, tone = 'text-slate-700' }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-4 py-1.5 text-xs">
      <span className="shrink-0 text-slate-400">{label}</span>
      <span className={`min-w-0 break-words text-right tabular-nums ${strong ? 'text-sm font-bold' : 'font-semibold'} ${tone}`}>{value}</span>
    </div>
  )
}

function ExplanationSection({ title, children, className = '' }) {
  return (
    <section className={`rounded-xl border border-slate-100 bg-slate-50/55 px-3 py-2.5 ${className}`}>
      <h5 className="mb-1 text-[11px] font-bold tracking-wide text-slate-500">{title}</h5>
      {children}
    </section>
  )
}

export function PayrollMonthlySummary({ employee, monthText, hidden = false, ambiguous = false }) {
  const value = (amount) => hidden ? '•••' : ambiguous ? '—' : money(amount)
  const components = [
    ['基础工资', employee?.basePay],
    ['业绩提成', employee?.commission],
    ['调货补贴', employee?.transferSubsidy],
    ['大单奖', employee?.bigBonus],
    ['工资调整', employee?.salaryAdjustment, true],
  ]
  return (
    <div data-testid="payroll-monthly-summary" className="mt-4 overflow-hidden rounded-2xl border border-budu-100 bg-gradient-to-br from-white to-budu-50/45">
      <div className="px-4 pb-4 pt-3.5">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] font-bold text-budu-600">{monthText}</span>
          {ambiguous && <span className="rounded-full bg-amber-50 px-2 py-1 text-[10px] font-semibold text-amber-600">身份归属待确认</span>}
        </div>
        <p className="mt-3 text-[11px] text-slate-400">本月最终工资</p>
        <p className="mt-1 break-all text-3xl font-black tracking-tight text-budu-700 tabular-nums" data-testid="monthly-final-pay">
          {value(employee?.salary)}
        </p>
        <div className="mt-4 grid grid-cols-3 divide-x divide-slate-100 rounded-xl bg-white/80 px-2 py-2.5 shadow-sm">
          <div className="min-w-0 px-2 text-center">
            <p className="text-[10px] text-slate-400">出勤天数</p>
            <p className="mt-0.5 text-xs font-bold text-slate-700">{ambiguous ? '—' : `${Number(employee?.workedDays) || 0}天`}</p>
          </div>
          <div className="min-w-0 px-2 text-center">
            <p className="text-[10px] text-slate-400">计薪工时</p>
            <p className="mt-0.5 text-xs font-bold text-slate-700">{ambiguous ? '—' : hours(employee?.hours)}</p>
          </div>
          <div className="min-w-0 px-2 text-center">
            <p className="text-[10px] text-slate-400">个人业绩分摊</p>
            <p className="mt-0.5 truncate text-xs font-bold text-slate-700">{hidden ? '•••' : ambiguous ? '—' : money(employee?.workedRevenue)}</p>
          </div>
        </div>
      </div>
      <div className="border-t border-budu-100/80 bg-white/90 px-4 py-3">
        <p className="mb-1.5 text-[11px] font-bold text-slate-500">工资组成</p>
        {components.map(([label, amount, signed]) => (
          <div key={label} data-stat-label={label} data-payroll-component={label} className="flex items-center justify-between gap-3 py-1 text-xs">
            <span className="text-slate-400">{label}</span>
            <span className={`font-semibold tabular-nums ${signed ? 'text-violet-600' : 'text-slate-700'}`}>
              {hidden ? '•••' : ambiguous ? '—' : signed ? signedMoney(amount) : money(amount)}
            </span>
          </div>
        ))}
        <div data-payroll-component="最终工资" className="mt-2 flex items-center justify-between border-t border-slate-100 pt-2.5">
          <span className="text-xs font-bold text-slate-700">最终工资</span>
          <span className="text-base font-black tabular-nums text-budu-700">{value(employee?.salary)}</span>
        </div>
      </div>
    </div>
  )
}

function AdjustmentOnlyDetails({ record }) {
  const adjustment = record.explanation?.adjustment
  return (
    <div className="space-y-2.5" data-testid="adjustment-only-details">
      <div className="rounded-xl border border-violet-100 bg-violet-50/70 px-3 py-2.5 text-xs font-semibold text-violet-700">
        无考勤记录
      </div>
      <ExplanationSection title="工资调整">
        <DetailRow label="自动工资" value={money(adjustment?.automaticPay ?? record.automaticPay)} />
        <DetailRow label="工资调整" value={signedMoney(adjustment?.salaryAdjustment ?? record.salaryAdjustment)} tone="text-violet-600" />
        <DetailRow label="最终工资" value={money(adjustment?.finalPay ?? record.finalPay)} strong tone="text-budu-700" />
        <DetailRow label="调整原因" value={adjustment?.reason || '—'} />
      </ExplanationSection>
    </div>
  )
}

export function PayrollDailyCard({ record }) {
  const [expanded, setExpanded] = useState(false)
  const explanation = record?.explanation || {}
  const bonuses = Array.isArray(explanation.bigOrderBonuses) ? explanation.bigOrderBonuses : []
  const adjustment = explanation.adjustment
  const adjustmentOnly = explanation.state === 'ADJUSTMENT_ONLY'
  const realZero = explanation.state === 'REAL_ZERO'
  const buttonLabel = expanded ? '收起详情' : '查看详情'

  return (
    <article data-testid="payroll-daily-card" data-payroll-state={explanation.state || ''} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="p-4">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-bold text-slate-800">{dateLabel(record.date)}</p>
            <p className="mt-1 truncate text-xs text-slate-400">{adjustmentOnly ? '工资调整' : record.storeName || record.storeKey || '门店信息暂缺'}</p>
          </div>
          <div className="min-w-0 shrink-0 text-right">
            <p className="text-[10px] text-slate-400">当日最终工资</p>
            <p className="mt-0.5 max-w-[132px] break-all text-lg font-black tabular-nums text-budu-700">{money(record.finalPay)}</p>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-slate-50 px-2.5 py-1 text-[11px] font-semibold text-slate-600">
            {adjustmentOnly ? '无考勤' : `计薪工时 ${hours(explanation.payableHours)}`}
          </span>
          {realZero && <span className="rounded-full bg-sky-50 px-2.5 py-1 text-[10px] font-semibold text-sky-600">真实 0 工时</span>}
          {bonuses.length > 0 && <span className="rounded-full bg-amber-50 px-2.5 py-1 text-[10px] font-semibold text-amber-600">有大单奖</span>}
          {adjustment && <span className="rounded-full bg-violet-50 px-2.5 py-1 text-[10px] font-semibold text-violet-600">有工资调整</span>}
        </div>
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="mt-3 flex min-h-10 w-full items-center justify-center gap-1 rounded-xl bg-slate-50 px-3 py-2 text-xs font-bold text-budu-600 transition hover:bg-budu-50"
        >
          {buttonLabel}
          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
      </div>

      {expanded && (
        <div className="space-y-2.5 border-t border-slate-100 bg-slate-50/30 p-3" data-testid="payroll-expanded-details">
          {adjustmentOnly ? (
            <AdjustmentOnlyDetails record={record} />
          ) : (
            <>
              <ExplanationSection title="当日情况">
                <DetailRow label="门店" value={record.storeName || record.storeKey || '—'} />
                <DetailRow label="计薪工时" value={hours(explanation.payableHours)} />
                <DetailRow label="工时来源" value={HOURS_SOURCE_LABELS[explanation.payableHoursSource] || '—'} />
                <DetailRow label="当日参与计薪人数" value={explanation.participantCount == null ? '—' : `${explanation.participantCount}人`} />
                <DetailRow label="计薪规则" value={DAY_POLICY_LABELS[explanation.calculationDayPolicy] || '—'} />
              </ExplanationSection>

              <ExplanationSection title="营业额与提成依据">
                <DetailRow label="门店营业额" value={money(explanation.rawStoreRevenue)} />
                <DetailRow label="个人业绩分摊" value={money(explanation.displayWorkedRevenue)} />
                <DetailRow label="提成计算基数" value={money(explanation.commissionBasis)} />
                <p className="mt-1.5 text-[10px] leading-4 text-slate-400">个人业绩分摊仅用于展示，提成按门店当日完整营业额计算。</p>
              </ExplanationSection>

              <ExplanationSection title="基础工资">
                <DetailRow label="基础时薪" value={rate(explanation.baseRate)} />
                <DetailRow label="计薪工时" value={hours(explanation.payableHours)} />
                <DetailRow label="基础工资" value={money(explanation.basePay)} strong />
              </ExplanationSection>

              <ExplanationSection title="业绩提成">
                <DetailRow label="提成计算基数" value={money(explanation.commissionBasis)} />
                <DetailRow label="提成目标" value={money(explanation.commissionTarget)} />
                <DetailRow label="提成时薪" value={rate(explanation.commissionRate)} />
                <DetailRow label="业绩提成" value={money(explanation.commission)} strong tone="text-budu-700" />
              </ExplanationSection>

              {(explanation.transferSubsidyRate !== 0 || explanation.transferSubsidy !== 0) && (
                <ExplanationSection title="调货补贴">
                  <DetailRow label="调货补贴标准" value={rate(explanation.transferSubsidyRate)} />
                  <DetailRow label="调货补贴" value={money(explanation.transferSubsidy)} strong tone="text-emerald-600" />
                </ExplanationSection>
              )}

              {bonuses.length > 0 && (
                <ExplanationSection title="大单奖">
                  <div className="space-y-2">
                    {bonuses.map((bonus, index) => (
                      <div key={`${index}-${bonus.orderAmount}-${bonus.bonusAmount}`} className="rounded-lg bg-white px-3 py-2 shadow-sm">
                        <p className="mb-1 text-[10px] font-bold text-amber-600">大单奖 {index + 1}</p>
                        <DetailRow label="大单订单金额" value={money(bonus.orderAmount)} />
                        <DetailRow label="大单奖" value={money(bonus.bonusAmount)} strong tone="text-amber-600" />
                        {bonus.receiptPresent && <p className="mt-1 text-[10px] font-semibold text-emerald-600">已上传凭证</p>}
                      </div>
                    ))}
                  </div>
                </ExplanationSection>
              )}

              {adjustment && (
                <ExplanationSection title="工资调整">
                  <DetailRow label="自动工资" value={money(adjustment.automaticPay)} />
                  <DetailRow label="工资调整" value={signedMoney(adjustment.salaryAdjustment)} tone="text-violet-600" />
                  <DetailRow label="调整后工资" value={money(adjustment.finalPay)} strong tone="text-budu-700" />
                  <DetailRow label="调整原因" value={adjustment.reason || '—'} />
                </ExplanationSection>
              )}

              <ExplanationSection title="当日最终工资" className="border-budu-100 bg-budu-50/70">
                <DetailRow label="最终工资" value={money(record.finalPay)} strong tone="text-budu-700" />
              </ExplanationSection>
            </>
          )}
        </div>
      )}
    </article>
  )
}

export function PayrollDailyList({ records = [], legacyRows = [], legacyLimited = false, legacyAmbiguous = false }) {
  if (legacyAmbiguous) {
    return (
      <div data-testid="payroll-legacy-ambiguous" className="rounded-2xl border border-amber-100 bg-amber-50/70 px-4 py-5 text-center text-sm font-semibold text-amber-700">
        同名员工工资归属无法确认，暂不展示详细明细
      </div>
    )
  }
  if (legacyLimited) {
    const rows = legacyRows.filter((row) => row?.hasData)
    return (
      <div className="space-y-3" data-testid="payroll-legacy-limited">
        <p className="rounded-xl border border-amber-100 bg-amber-50/70 px-3 py-2.5 text-xs font-medium text-amber-700">
          历史兼容数据，部分计算明细不可展示
        </p>
        {rows.map((row) => (
          <div key={row.day} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-bold text-slate-800">{row.day}</p>
                <p className="mt-1 text-xs text-slate-400">{row.stores || '历史工资记录'}</p>
              </div>
              <div className="text-right">
                <p className="text-[10px] text-slate-400">当日工资</p>
                <p className="text-lg font-black text-budu-700">{money(row.pay)}</p>
              </div>
            </div>
            <p className="mt-2 text-xs text-slate-500">计薪工时：{hours(row.hours)}</p>
          </div>
        ))}
        {rows.length === 0 && <p className="py-8 text-center text-sm text-slate-400">暂无工资数据</p>}
      </div>
    )
  }
  if (!Array.isArray(records) || records.length === 0) {
    return <p data-testid="payroll-no-data" className="py-10 text-center text-sm text-slate-400">暂无工资数据</p>
  }
  return (
    <div className="space-y-3" data-testid="payroll-daily-list">
      {records.map((record, index) => (
        <PayrollDailyCard key={`${record.employeeId || 'employee'}-${record.date}-${record.storeKey || 'adjustment'}-${index}`} record={record} />
      ))}
    </div>
  )
}

export function PayrollExplanationHeading() {
  return (
    <div className="flex items-center gap-2">
      <span className="grid h-9 w-9 place-items-center rounded-xl bg-budu-50 text-budu-600"><CircleDollarSign className="h-5 w-5" /></span>
      <div>
        <h4 className="text-sm font-bold text-slate-800">每日工资明细</h4>
        <p className="text-[11px] text-slate-400">点击日期查看计薪依据</p>
      </div>
    </div>
  )
}
