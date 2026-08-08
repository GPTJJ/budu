/** 通用加载骨架：登录/首屏用 AppLoading，板块页用 PageLoading（不承载任何业务逻辑） */
function SkeletonBlock({ className = '' }) {
  return <div className={`skeleton ${className}`} />
}

export function AppLoading() {
  return (
    <div className="grid min-h-screen min-h-[100dvh] place-items-center bg-canvas px-4" role="status" aria-label="加载中">
      <div className="card w-full max-w-sm space-y-4 p-6 sm:p-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <SkeletonBlock className="h-14 w-14 rounded-2xl" />
          <SkeletonBlock className="h-5 w-40" />
          <SkeletonBlock className="h-3 w-56" />
        </div>
        <SkeletonBlock className="h-11" />
        <SkeletonBlock className="h-11" />
        <SkeletonBlock className="h-11" />
      </div>
    </div>
  )
}

export default function PageLoading() {
  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-4 px-3 py-4 sm:space-y-6 sm:px-5 sm:py-6 lg:px-8" role="status" aria-label="加载中">
      <section className="grid grid-cols-2 gap-3 sm:gap-5 xl:grid-cols-3 2xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="card p-4 sm:p-5">
            <SkeletonBlock className="h-16 sm:h-20" />
          </div>
        ))}
      </section>
      <section className="grid grid-cols-1 gap-5 xl:grid-cols-12">
        <div className="xl:col-span-4">
          <div className="card p-5">
            <SkeletonBlock className="h-64" />
          </div>
        </div>
        <div className="xl:col-span-5">
          <div className="card p-5">
            <SkeletonBlock className="h-64" />
          </div>
        </div>
        <div className="xl:col-span-3">
          <div className="card p-5">
            <SkeletonBlock className="h-64" />
          </div>
        </div>
      </section>
    </div>
  )
}
