import { useEffect, useRef, useState } from 'react'
import iconUrl from '../assets/pull-refresh-icon.png'

const THRESHOLD = 64

/** 移动端下拉刷新：页面顶部下拉超过阈值后触发 onRefresh（仅触屏设备） */
export default function PullToRefresh({ onRefresh, children }) {
  const [pull, setPull] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const startY = useRef(null)
  const pulling = useRef(false)
  const pullRef = useRef(0)

  const updatePull = (v) => {
    pullRef.current = v
    setPull(v)
  }

  useEffect(() => {
    if (!('ontouchstart' in window)) return undefined

    const onTouchStart = (e) => {
      if (refreshing || window.scrollY > 0) return
      const t = e.touches && e.touches[0]
      if (!t) return
      startY.current = t.clientY
      pulling.current = true
    }

    const onTouchMove = (e) => {
      if (!pulling.current || refreshing) return
      const t = e.touches && e.touches[0]
      if (!t || startY.current == null) return
      if (window.scrollY > 0) return
      const dy = t.clientY - startY.current
      if (dy <= 0) {
        updatePull(0)
        return
      }
      if (dy > 8 && e.cancelable) e.preventDefault()
      updatePull(Math.min(dy * 0.45, 96))
    }

    const onTouchEnd = async () => {
      if (!pulling.current) return
      pulling.current = false
      startY.current = null
      if (pullRef.current >= THRESHOLD && !refreshing) {
        setRefreshing(true)
        updatePull(48)
        try {
          await onRefresh()
        } finally {
          setRefreshing(false)
          updatePull(0)
        }
      } else {
        updatePull(0)
      }
    }

    window.addEventListener('touchstart', onTouchStart, { passive: true })
    window.addEventListener('touchmove', onTouchMove, { passive: false })
    window.addEventListener('touchend', onTouchEnd, { passive: true })
    return () => {
      window.removeEventListener('touchstart', onTouchStart)
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('touchend', onTouchEnd)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshing, onRefresh])

  return (
    <>
      {children}
      {pull > 0 && (
        <div
          className="pointer-events-none fixed inset-x-0 top-0 z-[120] flex justify-center"
          style={{ paddingTop: 'env(safe-area-inset-top)' }}
        >
          <div
            className="mt-1 flex flex-col items-center gap-0.5 rounded-2xl border border-white/60 bg-white/85 px-3 py-1.5 shadow-lg backdrop-blur"
            style={{ transform: `translateY(${Math.max(pull - 24, 0)}px)` }}
          >
            <img
              src={iconUrl}
              alt=""
              draggable={false}
              className={`w-12 select-none ${
                refreshing
                  ? 'animate-[budu-wiggle_0.6s_ease-in-out_infinite]'
                  : pull >= THRESHOLD
                    ? 'animate-[budu-bounce_0.3s_ease-out_1]'
                    : ''
              }`}
              style={{
                transform: refreshing
                  ? undefined
                  : `scale(${(0.85 + (pull / 96) * 0.25).toFixed(3)}) rotate(${(-8 + (pull / 96) * 8).toFixed(2)}deg)`,
              }}
            />
            <span className="text-[10px] font-medium text-slate-500">
              {refreshing ? '刷新中…' : pull >= THRESHOLD ? '释放刷新' : '下拉刷新'}
            </span>
          </div>
        </div>
      )}
    </>
  )
}
