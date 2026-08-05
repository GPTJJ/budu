import { MapPin, Bell, Menu, ChevronDown, LogOut } from 'lucide-react'
import { STORES } from '../utils/selectors'
import CalendarPicker from './CalendarPicker'

export default function Header({ month, store, day, onDaySelect, onMonthChange, onStoreChange, onMenuClick, user, onLogout }) {
  const name = user?.username || '伙伴'
  const roleText = user?.role === 'admin' ? '管理员' : '门店运营'
  const initial = name.slice(0, 2).toUpperCase()
  return (
    <header className="sticky top-0 z-20 border-b border-white/60 bg-[#F7F4FA]/80 backdrop-blur-md">
      <div className="flex items-center justify-between gap-4 px-5 py-4 lg:px-8">
        {/* 问候语 */}
        <div className="flex min-w-0 items-center gap-3">
          <button
            onClick={onMenuClick}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-white text-slate-500 shadow-card lg:hidden"
            aria-label="打开菜单"
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-bold text-slate-800 sm:text-xl">
              下午好，{name} 👋
            </h1>
            <p className="mt-0.5 truncate text-[13px] text-slate-400">
              欢迎回来，今天也要元气满满地经营每一家门店！
            </p>
          </div>
        </div>

        {/* 右侧工具栏 */}
        <div className="flex shrink-0 items-center gap-2.5 sm:gap-3">
          {/* 日历选择（月 / 日双模式） */}
          <CalendarPicker month={month} day={day} onSelect={onDaySelect} />

          {/* 门店选择 */}
          <label className="flex items-center gap-2 rounded-2xl bg-white px-3.5 py-2.5 text-sm shadow-card transition hover:shadow-card-hover">
            <MapPin className="h-4 w-4 text-grape-500" />
            <select
              value={store}
              onChange={(e) => onStoreChange(e.target.value)}
              className="max-w-[120px] cursor-pointer appearance-none bg-transparent pr-1 text-sm font-semibold text-slate-600 outline-none sm:max-w-[160px]"
            >
              <option value="all">全部门店</option>
              {STORES.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.name}
                </option>
              ))}
            </select>
            <ChevronDown className="h-3.5 w-3.5 text-slate-300" />
          </label>

          {/* 消息通知 */}
          <button className="relative grid h-11 w-11 place-items-center rounded-2xl bg-white text-slate-500 shadow-card transition hover:shadow-card-hover hover:text-budu-500">
            <Bell className="h-[18px] w-[18px]" />
            <span className="absolute right-2.5 top-2.5 h-2 w-2 rounded-full border-2 border-white bg-rose-500" />
          </button>

          {/* 用户头像 */}
          <div className="hidden items-center gap-2.5 rounded-2xl bg-white py-1.5 pl-1.5 pr-4 shadow-card sm:flex">
            <div className="grid h-8 w-8 place-items-center rounded-xl bg-gradient-to-br from-budu-400 to-grape-500 text-xs font-bold text-white">
              {initial}
            </div>
            <div className="leading-tight">
              <p className="text-[13px] font-semibold text-slate-700">{name}</p>
              <p className="text-[11px] text-slate-400">{roleText}</p>
            </div>
          </div>

          {/* 退出登录 */}
          <button
            onClick={() => {
              if (window.confirm('确定要退出登录吗？')) onLogout()
            }}
            className="grid h-11 w-11 place-items-center rounded-2xl bg-white text-slate-400 shadow-card transition hover:text-rose-500 hover:shadow-card-hover"
            title="退出登录"
            aria-label="退出登录"
          >
            <LogOut className="h-[18px] w-[18px]" />
          </button>
        </div>
      </div>
    </header>
  )
}