import { Package, Wallet, Megaphone, Users, MonitorCheck, TrendingUp, AlertTriangle, Database, Sparkles, Bell } from 'lucide-react'
import Card from './Card'
import { notices } from '../utils/selectors'
import { useI18n } from '../i18n'
import { usePublicMode, useStorePrivacy } from '../visibility'

const ICON_MAP = {
  库存: Package,
  财务: Wallet,
  活动: Megaphone,
  人员: Users,
  系统: MonitorCheck,
  经营: TrendingUp,
  关注: AlertTriangle,
  预警: AlertTriangle,
  增长: TrendingUp,
  绩效: Sparkles,
  数据: Database,
}

// 门店运营账号隐藏与经营数据相关的提醒
const SENSITIVE_TAGS = new Set(['经营', '财务', '增长', '绩效', '数据', '预警', '关注'])

export default function NotificationPanel({ month, day }) {
  const { lang, t } = useI18n()
  const isPublic = usePublicMode()
  const isStore = useStorePrivacy()
  const items = notices(month, day, lang).filter((i) => !(isStore && SENSITIVE_TAGS.has(i.tag)))

  return (
    <Card
      title={t('重要提醒')}
      subtitle={
        day ? t('聚焦 {day} · 基于报表自动生成', { day }) : t('基于所选月份与报表自动生成')
      }
      action={
        !isPublic && (
        <span className="grid h-8 w-8 place-items-center rounded-xl bg-budu-50 text-sm font-bold text-budu-500">
          {items.length}
        </span>
        )
      }
    >
      {isPublic ? (
        <div className="grid h-48 place-items-center text-xs text-slate-300">
          {t('对外展示模式 · 数据已隐藏')}
        </div>
      ) : (
        <ul className="space-y-4">
        {items.map((item, idx) => {
          const Icon = ICON_MAP[item.tag] || Bell
          return (
            <li key={idx} className="group flex gap-3">
              <div className={`mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl ${item.bg} ${item.fg}`}>
                <Icon className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1 border-b border-slate-50 pb-3.5 last:border-0 last:pb-0">
                <div className="flex items-center gap-2">
                  <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${item.tagStyle}`}>
                    {t(item.tag)}
                  </span>
                  <span className="text-[11px] text-slate-300">{item.time}</span>
                </div>
                <p className="mt-1.5 text-[13px] leading-5 text-slate-600 transition-colors group-hover:text-slate-800">
                  {item.text}
                </p>
              </div>
            </li>
          )
        })}
        </ul>
      )}
    </Card>
  )
}
