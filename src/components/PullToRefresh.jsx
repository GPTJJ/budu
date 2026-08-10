import { useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'

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
            className="mt-2 flex items-center gap-2 rounded-full bg-white/95 px-4 py-2 text-xs font-medium text-slate-500 shadow-lg"
            style={{ transform: `translateY(${Math.max(pull - 16, 0)}px)` }}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin text-budu-500' : ''}`} />
            {refreshing ? '刷新中…' : pull >= THRESHOLD ? '释放刷新' : '下拉刷新'}
          </div>
        </div>
      )}
    </>
  )
}
