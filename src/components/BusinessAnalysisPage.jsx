import { lazy, Suspense } from 'react'
import { ArrowLeft, ChartNoAxesCombined } from 'lucide-react'
import { useI18n } from '../i18n'

const StoreRankingTable = lazy(() => import('./StoreRankingTable'))
const RevenueTrendChart = lazy(() => import('./RevenueTrendChart'))
const ChannelChart = lazy(() => import('./ChannelChart'))
const EmployeePerformanceTable = lazy(() => import('./EmployeePerformanceTable'))
const ProductSalesTable = lazy(() => import('./ProductSalesTable'))

function AnalysisSkeleton() {
  return (
    <section className="grid grid-cols-1 gap-5 xl:grid-cols-12" aria-label="经营分析加载中">
      {[1, 2, 3].map((item) => (
        <div
          key={item}
          className={`h-[260px] animate-pulse rounded-2xl bg-slate-100 ${item === 1 ? 'xl:col-span-4' : item === 2 ? 'xl:col-span-5' : 'xl:col-span-3'}`}
        />
      ))}
    </section>
  )
}

export default function BusinessAnalysisPage({ month, store, day, weekStart, user, onBack }) {
  const { t } = useI18n()

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 rounded-2xl bg-white px-3.5 py-2.5 text-sm font-medium text-slate-500 shadow-card transition hover:text-budu-600"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('返回首页')}
        </button>
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold text-slate-800">
            <ChartNoAxesCombined className="h-5 w-5 text-budu-500" />
            {t('经营分析')}
          </h2>
          <p className="mt-0.5 text-[13px] text-slate-400">
            {t('集中查看门店排行、经营趋势、渠道、员工与商品表现')}
          </p>
        </div>
      </div>

      <Suspense fallback={<AnalysisSkeleton />}>
        <section className="grid grid-cols-1 gap-5 xl:grid-cols-12">
          <div className="xl:col-span-4">
            <StoreRankingTable month={month} store={store} day={day} weekStart={weekStart} />
          </div>
          <div className="xl:col-span-5">
            <RevenueTrendChart month={month} store={store} day={day} weekStart={weekStart} />
          </div>
          <div className="xl:col-span-3">
            <ChannelChart month={month} store={store} day={day} weekStart={weekStart} />
          </div>
        </section>
      </Suspense>

      <Suspense fallback={<AnalysisSkeleton />}>
        <section className="grid grid-cols-1 gap-5 xl:grid-cols-12">
          <div className="xl:col-span-5">
            <EmployeePerformanceTable store={store} month={month} day={day} weekStart={weekStart} user={user} />
          </div>
          <div className="xl:col-span-7">
            <ProductSalesTable month={month} store={store} day={day} weekStart={weekStart} />
          </div>
        </section>
      </Suspense>
    </div>
  )
}
