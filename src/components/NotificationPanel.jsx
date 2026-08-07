import { useEffect, useMemo, useState } from 'react'
import { CloudSun, Megaphone, Truck } from 'lucide-react'
import Card from './Card'
import { getInventoryRequests } from '../utils/userData'
import { storeName } from '../utils/selectors'
import { api } from '../utils/api'
import { CHANGELOG } from '../data/changelog'
import { useI18n } from '../i18n'

const CARE_TIPS = [
  '记得多喝水，保持好状态',
  '早晚温差大，注意添衣',
  '午间阳光强，注意防晒',
  '忙碌之余记得休息一下',
  '今日也要元气满满地经营门店',
]

export default function NotificationPanel() {
  const { t } = useI18n()
  const [tick, setTick] = useState(0)
  const [weather, setWeather] = useState(null)
  const [weatherError, setWeatherError] = useState(false)

  useEffect(() => {
    let alive = true
    api('/v2/weather')
      .then((d) => {
        if (!alive) return
        if (d && d.ok) setWeather(d)
        else setWeatherError(true)
      })
      .catch(() => alive && setWeatherError(true))
    return () => {
      alive = false
    }
  }, [])

  // 每 8 秒与全局数据同步保持一致：调拨处理后自动从列表消失
  useEffect(() => {
    const id = setInterval(() => setTick((v) => v + 1), 8000)
    return () => clearInterval(id)
  }, [])

  const transfers = useMemo(
    () =>
      getInventoryRequests()
        .filter((r) => r.type === 'transfer' && (r.status === 'pending' || r.status === 'in_transit'))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tick],
  )

  const updates = CHANGELOG.slice(0, 2)
  const tip = CARE_TIPS[new Date().getDate() % CARE_TIPS.length]
  const total = updates.length + transfers.length + 1

  return (
    <Card
      title={t('重要提醒')}
      subtitle={t('版本更新 · 库存调拨 · 今日天气')}
      action={
        <span className="grid h-8 w-8 place-items-center rounded-xl bg-budu-50 text-sm font-bold text-budu-500">
          {total}
        </span>
      }
    >
      <ul className="space-y-4">
        {/* 版本更新 */}
        {updates.map((v) => (
          <li key={v.version} className="flex gap-3">
            <div className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-budu-100 text-budu-600">
              <Megaphone className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1 border-b border-slate-50 pb-3.5 last:border-0 last:pb-0">
              <div className="flex items-center gap-2">
                <span className="rounded-md bg-budu-50 px-1.5 py-0.5 text-[10px] font-bold text-budu-600">
                  {t('版本更新')}
                </span>
                <span className="text-[11px] font-bold text-slate-600">{v.version}</span>
                <span className="text-[11px] text-slate-300">{v.date}</span>
              </div>
              <ul className="mt-1.5 space-y-0.5">
                {v.items.map((item, idx) => (
                  <li key={idx} className="text-[13px] leading-5 text-slate-600">
                    · {item}
                  </li>
                ))}
              </ul>
            </div>
          </li>
        ))}

        {/* 库存调拨 */}
        {transfers.map((r) => (
          <li key={r.id} className="flex gap-3">
            <div className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-sky-100 text-sky-600">
              <Truck className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1 border-b border-slate-50 pb-3.5 last:border-0 last:pb-0">
              <div className="flex items-center gap-2">
                <span className="rounded-md bg-sky-50 px-1.5 py-0.5 text-[10px] font-bold text-sky-600">
                  {t('库存调拨')}
                </span>
                <span
                  className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold ${
                    r.status === 'in_transit' ? 'bg-blue-50 text-blue-600' : 'bg-amber-50 text-amber-600'
                  }`}
                >
                  {t(r.status === 'in_transit' ? '运输中' : '待审核')}
                </span>
              </div>
              <p className="mt-1.5 text-[13px] leading-5 text-slate-600">
                {t('从 {from} 调往 {to}', {
                  from: storeName(r.fromStoreKey),
                  to: storeName(r.storeKey),
                })}
                {' · '}
                {t('{count} 种货品', { count: r.items ? r.items.length : 1 })}
              </p>
              <p className="mt-0.5 text-[11px] text-slate-300">
                {r.createdBy} · {new Date(r.createdAt).toLocaleString()}
              </p>
            </div>
          </li>
        ))}
        {transfers.length === 0 && (
          <li className="flex gap-3">
            <div className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-slate-50 text-slate-400">
              <Truck className="h-4 w-4" />
            </div>
            <p className="flex-1 border-b border-slate-50 pb-3.5 text-[13px] text-slate-400">
              {t('暂无待处理调拨')}
            </p>
          </li>
        )}

        {/* 今日天气与关心信息 */}
        <li className="flex gap-3">
          <div className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-emerald-100 text-emerald-600">
            <CloudSun className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="rounded-md bg-emerald-50 px-1.5 py-0.5 text-[10px] font-bold text-emerald-600">
                {t('今日天气')}
              </span>
            </div>
            {weather ? (
              <p className="mt-1.5 text-[13px] leading-5 text-slate-600">
                {t('{city}：{text}，{temp}℃，湿度 {humidity}%', {
                  city: weather.city,
                  text: weather.text || '—',
                  temp: weather.temp,
                  humidity: weather.humidity,
                })}
              </p>
            ) : weatherError ? (
              <p className="mt-1.5 text-[13px] text-slate-400">{t('天气服务暂不可用')}</p>
            ) : (
              <p className="mt-1.5 text-[13px] text-slate-400">{t('天气加载中…')}</p>
            )}
            <p className="mt-1 text-[12px] text-emerald-600">💚 {t(tip)}</p>
          </div>
        </li>
      </ul>
    </Card>
  )
}
