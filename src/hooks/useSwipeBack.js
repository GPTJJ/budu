import { useEffect, useRef } from 'react'
import { isSwipeBackGesture, SWIPE_BACK_EDGE_PX } from '../utils/swipeBack'

const IGNORE_SELECTOR = 'input, textarea, select, [contenteditable="true"], [data-swipe-back-ignore="true"]'

function isTouchDevice() {
  return navigator.maxTouchPoints > 0 || 'ontouchstart' in window
}

/**
 * 移动触屏设备左侧边缘右滑返回。
 * 仅在确认是横向手势后阻止默认滚动，避免影响页面的上下滚动。
 */
export default function useSwipeBack({ enabled = true, onBack }) {
  const onBackRef = useRef(onBack)
  const gestureRef = useRef(null)

  useEffect(() => {
    onBackRef.current = onBack
  }, [onBack])

  useEffect(() => {
    if (!enabled || !isTouchDevice()) return undefined

    const reset = () => {
      gestureRef.current = null
    }

    const onTouchStart = (event) => {
      if (event.touches?.length !== 1) return reset()
      const touch = event.touches[0]
      const target = event.target instanceof Element ? event.target : null
      if (touch.clientX > SWIPE_BACK_EDGE_PX || target?.closest(IGNORE_SELECTOR)) return reset()
      gestureRef.current = {
        startX: touch.clientX,
        startY: touch.clientY,
        startedAt: performance.now(),
        horizontal: false,
      }
    }

    const onTouchMove = (event) => {
      const gesture = gestureRef.current
      const touch = event.touches?.[0]
      if (!gesture || !touch) return
      const dx = touch.clientX - gesture.startX
      const dy = touch.clientY - gesture.startY

      if (dx < -8 || (Math.abs(dy) > 18 && Math.abs(dy) > Math.abs(dx))) {
        reset()
        return
      }
      if (dx > 12 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        gesture.horizontal = true
        if (event.cancelable) event.preventDefault()
      }
    }

    const onTouchEnd = (event) => {
      const gesture = gestureRef.current
      const touch = event.changedTouches?.[0]
      reset()
      if (!gesture?.horizontal || !touch) return
      if (isSwipeBackGesture({
        startX: gesture.startX,
        startY: gesture.startY,
        endX: touch.clientX,
        endY: touch.clientY,
        duration: performance.now() - gesture.startedAt,
      })) onBackRef.current?.()
    }

    window.addEventListener('touchstart', onTouchStart, { passive: true })
    window.addEventListener('touchmove', onTouchMove, { passive: false })
    window.addEventListener('touchend', onTouchEnd, { passive: true })
    window.addEventListener('touchcancel', reset, { passive: true })
    return () => {
      window.removeEventListener('touchstart', onTouchStart)
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('touchend', onTouchEnd)
      window.removeEventListener('touchcancel', reset)
    }
  }, [enabled])
}

