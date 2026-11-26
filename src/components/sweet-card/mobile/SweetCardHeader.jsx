import { ArrowLeft, Bell, SlidersHorizontal } from 'lucide-react'
import BuduWordmark from '../../brand/BuduWordmark'

const TONES = {
  live: 'bg-emerald-50 text-emerald-700 ring-emerald-100',
  idle: 'bg-amber-50 text-amber-700 ring-amber-100',
  off: 'bg-slate-100 text-slate-500 ring-slate-200',
}

/** 单行导航：返回 · budu 字标 · 甜意卡 · 运营状态胶囊 · 配置中心 · 通知。 */
export default function SweetCardHeader({ onBack, statusLabel, statusTone = 'live', onOpenConfig, onOpenNotifications, notificationCount = 0 }) {
  return (
    <header className="sticky top-0 z-30 border-b border-slate-100 bg-white/90 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-[560px] items-center gap-2 px-2.5">
        <button type="button" onClick={onBack} aria-label="返回" className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-slate-500 active:bg-slate-100">
          <ArrowLeft className="h-[18px] w-[18px]" />
        </button>
        <BuduWordmark height={13} className="shrink-0 text-slate-900" />
        <h1 className="shrink-0 text-[15px] font-black tracking-tight text-slate-900">甜意卡</h1>
        <span className={`ml-0.5 max-w-[96px] shrink truncate rounded-full px-2 py-[3px] text-[10px] font-black ring-1 ${TONES[statusTone] || TONES.live}`}>
          {statusLabel}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button type="button" onClick={onOpenConfig} aria-label="配置中心" className="grid h-9 w-9 place-items-center rounded-xl text-slate-500 active:bg-slate-100">
            <SlidersHorizontal className="h-[18px] w-[18px]" />
          </button>
          <button type="button" onClick={onOpenNotifications} aria-label="通知" className="relative grid h-9 w-9 place-items-center rounded-xl text-slate-500 active:bg-slate-100">
            <Bell className="h-[18px] w-[18px]" />
            {notificationCount > 0 && <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-budu-500 ring-2 ring-white" />}
          </button>
        </div>
      </div>
    </header>
  )
}
