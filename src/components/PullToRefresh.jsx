import { useEffect, useRef, useState } from 'react'
import { ArrowDown } from 'lucide-react'

const THRESHOLD = 64
const overlayStackOpen = () => document.documentElement.classList.contains('budu-overlay-open')

/** 移动端下拉刷新：页面顶部下拉超过阈值后触发 onRefresh（仅触屏设备） */
export default function PullToRefresh({ onRefresh, children }) {
  const [pull, setPull] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const startY = useRef(null)
  const startX = useRef(null)
  const pulling = useRef(false)
  const pullRef = useRef(0)

  const updatePull = (v) => {
    pullRef.current = v
    setPull(v)
  }

  useEffect(() => {
    if (!('ontouchstart' in window)) return undefined

    const cancelPull = () => {
      pulling.current = false
      startY.current = null
      startX.current = null
      updatePull(0)
    }

    const onTouchStart = (e) => {
      if (refreshing || overlayStackOpen() || window.scrollY > 0) return
      const t = e.touches && e.touches[0]
      if (!t) return
      startY.current = t.clientY
      startX.current = t.clientX
      pulling.current = true
    }

    const onTouchMove = (e) => {
      if (!pulling.current || refreshing) return
      if (overlayStackOpen()) {
        cancelPull()
        return
      }
      const t = e.touches && e.touches[0]
      if (!t || startY.current == null) return
      if (window.scrollY > 0) return
      const dy = t.clientY - startY.current
      const dx = t.clientX - startX.current
      if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        pulling.current = false
        startX.current = null
        startY.current = null
        updatePull(0)
        return
      }
      if (dy <= 0) {
        updatePull(0)
        return
      }
      if (dy > 8 && e.cancelable) e.preventDefault()
      updatePull(Math.min(dy * 0.45, 96))
    }

    const onTouchEnd = async () => {
      if (!pulling.current) return
      if (overlayStackOpen()) {
        cancelPull()
        return
      }
      pulling.current = false
      startY.current = null
      startX.current = null
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
    const overlayObserver = new MutationObserver(() => {
      if (overlayStackOpen()) cancelPull()
    })
    overlayObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => {
      overlayObserver.disconnect()
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
          <div style={{ transform: `translateY(${Math.max(pull - 20, 0)}px)` }}>
            <div
              className={`flex items-center gap-2 rounded-full border border-slate-200/70 bg-white/85 px-3 py-1.5 shadow-sm backdrop-blur-md ${
                refreshing ? 'opacity-95' : ''
              }`}
            >
              <span className="relative grid h-6 w-6 shrink-0 place-items-center">
                <span className="absolute inset-0 rounded-full border-2 border-slate-200/80" />
                <span
                  className={`absolute inset-0 rounded-full border-2 border-transparent border-t-budu-500 transition-transform duration-100 motion-reduce:transition-none ${
                    refreshing ? 'animate-spin motion-reduce:animate-none' : ''
                  }`}
                  style={{
                    transform: refreshing ? undefined : `rotate(${Math.min(pull / 96, 1) * 360}deg)`,
                  }}
                />
                {!refreshing && (
                  <ArrowDown
                    className={`h-3 w-3 text-budu-500 transition-transform duration-200 motion-reduce:transition-none ${
                      pull >= THRESHOLD ? 'rotate-180' : ''
                    }`}
                  />
                )}
              </span>
              <span className="select-none text-[11px] font-medium text-slate-600">
                {refreshing ? '刷新中…' : pull >= THRESHOLD ? '释放刷新' : '下拉刷新'}
              </span>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
