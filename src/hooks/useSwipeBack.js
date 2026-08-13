import { useEffect, useRef } from 'react'
import { isSwipeBackGesture, SWIPE_BACK_EDGE_PX } from '../utils/swipeBack'

const IGNORE_SELECTOR = 'input, textarea, select, [contenteditable="true"], [data-swipe-back-ignore="true"]'

function isTouchDevice() {
  return navigator.maxTouchPoints > 0 || 'ontouchstart' in window
}

const ACTIVE_CLASS = 'swipe-back-active'
const SETTLING_CLASS = 'swipe-back-settling'
const VISUAL_RESET_DELAY_MS = 300

function setSwipeVisual(x, progress) {
  const root = document.documentElement
  const safeProgress = Math.max(0, Math.min(1, progress))
  root.style.setProperty('--swipe-back-x', `${Math.max(0, x)}px`)
  root.style.setProperty('--swipe-back-progress', String(safeProgress))
  root.style.setProperty('--swipe-back-scale', String(1 - safeProgress * 0.012))
  root.style.setProperty('--swipe-back-radius', `${safeProgress * 20}px`)
  root.style.setProperty('--swipe-back-indicator-x', `${-46 + safeProgress * 54}px`)
}

function clearSwipeVisual() {
  const root = document.documentElement
  root.classList.remove(ACTIVE_CLASS, SETTLING_CLASS)
  root.style.removeProperty('--swipe-back-x')
  root.style.removeProperty('--swipe-back-progress')
  root.style.removeProperty('--swipe-back-scale')
  root.style.removeProperty('--swipe-back-radius')
  root.style.removeProperty('--swipe-back-indicator-x')
}

/**
 * 移动触屏设备左侧边缘右滑返回。
 * 仅在确认是横向手势后阻止默认滚动，避免影响页面的上下滚动。
 */
export default function useSwipeBack({ enabled = true, onBack }) {
  const onBackRef = useRef(onBack)
  const gestureRef = useRef(null)
  const settleTimerRef = useRef(0)

  useEffect(() => {
    onBackRef.current = onBack
  }, [onBack])

  useEffect(() => {
    if (!enabled || !isTouchDevice()) return undefined

    const stopSettling = () => {
      if (settleTimerRef.current) window.clearTimeout(settleTimerRef.current)
      settleTimerRef.current = 0
      clearSwipeVisual()
    }

    const resetGesture = () => {
      gestureRef.current = null
    }

    const settle = ({ complete = false } = {}) => {
      const gesture = gestureRef.current
      resetGesture()
      const root = document.documentElement
      if (!gesture?.horizontal) {
        stopSettling()
        return
      }
      root.classList.add(ACTIVE_CLASS, SETTLING_CLASS)
      setSwipeVisual(0, 0)
      if (complete) {
        // 先切换页面，再让新页面从手指松开的位置平滑归位，避免瞬间跳变。
        window.requestAnimationFrame(() => onBackRef.current?.())
      }
      settleTimerRef.current = window.setTimeout(stopSettling, VISUAL_RESET_DELAY_MS)
    }

    const onTouchStart = (event) => {
      if (event.touches?.length !== 1) return resetGesture()
      const touch = event.touches[0]
      const target = event.target instanceof Element ? event.target : null
      if (touch.clientX > SWIPE_BACK_EDGE_PX || target?.closest(IGNORE_SELECTOR)) return resetGesture()
      stopSettling()
      gestureRef.current = {
        startX: touch.clientX,
        startY: touch.clientY,
        startedAt: performance.now(),
        horizontal: false,
        lastX: touch.clientX,
      }
    }

    const onTouchMove = (event) => {
      const gesture = gestureRef.current
      const touch = event.touches?.[0]
      if (!gesture || !touch) return
      const dx = touch.clientX - gesture.startX
      const dy = touch.clientY - gesture.startY

      if (dx < -8 || (Math.abs(dy) > 18 && Math.abs(dy) > Math.abs(dx))) {
        if (gesture.horizontal) settle()
        else resetGesture()
        return
      }
      if (dx > 12 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        gesture.horizontal = true
        gesture.lastX = touch.clientX
        const viewportWidth = Math.max(window.innerWidth, 320)
        const progress = Math.min(1, dx / Math.min(viewportWidth * 0.58, 260))
        // 手指保持近似 1:1 跟随，越往后略加阻尼，兼顾可控感与轻盈感。
        const offset = dx * (0.92 - progress * 0.14)
        document.documentElement.classList.add(ACTIVE_CLASS)
        setSwipeVisual(offset, progress)
        if (event.cancelable) event.preventDefault()
      }
    }

    const onTouchEnd = (event) => {
      const gesture = gestureRef.current
      const touch = event.changedTouches?.[0]
      if (!gesture?.horizontal || !touch) return resetGesture()
      const complete = isSwipeBackGesture({
        startX: gesture.startX,
        startY: gesture.startY,
        endX: touch.clientX,
        endY: touch.clientY,
        duration: performance.now() - gesture.startedAt,
      })
      settle({ complete })
    }

    const onTouchCancel = () => settle()

    window.addEventListener('touchstart', onTouchStart, { passive: true })
    window.addEventListener('touchmove', onTouchMove, { passive: false })
    window.addEventListener('touchend', onTouchEnd, { passive: true })
    window.addEventListener('touchcancel', onTouchCancel, { passive: true })
    return () => {
      window.removeEventListener('touchstart', onTouchStart)
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('touchend', onTouchEnd)
      window.removeEventListener('touchcancel', onTouchCancel)
      resetGesture()
      // 返回动作可能导致当前组件立即卸载；保留已启动的回位动画，由计时器统一收尾。
      if (!settleTimerRef.current) clearSwipeVisual()
    }
  }, [enabled])
}
