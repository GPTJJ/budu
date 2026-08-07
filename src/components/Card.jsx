/** 通用卡片容器：标题 + 副标题 + 右侧操作区 */
export default function Card({ title, subtitle, action, children, className = '' }) {
  return (
    <section className={`card flex h-full flex-col p-4 sm:p-6 ${className}`}>
      <div className="mb-4 flex items-start justify-between gap-3 sm:mb-5">
        <div>
          <h3 className="text-[15px] font-bold tracking-wide text-slate-800">{title}</h3>
          {subtitle && <p className="mt-1 text-xs text-slate-400">{subtitle}</p>}
        </div>
        {action}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </section>
  )
}
