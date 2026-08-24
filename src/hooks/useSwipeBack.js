// 移动端左侧边缘右滑返回（Interactive Pop Gesture，接近 iOS interactivePopGestureRecognizer）
//
// 交互模型：
//   touchstart（左边缘）→ 记录手势起点
//   touchmove（确认横向）→ 当前页 1:1 跟手右移，上一页快照从左侧 parallax 露出
//   touchend → 距离/速度阈值判定
//     达到阈值 → 先播完成动画（当前页滑出、上一页回正）→ 动画结束才真正执行返回 → 清理
//     未达阈值 → 自然回弹 → 清理
//
// 关键设计：
// - 拖动阶段 transform 直接由手指位移驱动（无固定 transition，1:1 跟手）
// - 上一页：真实 DOM 快照层（#swipe-prev-layer，z-index 1），当前页 #root（z-index 2）
// - 手势/动画期间不触发 React setState，只写 CSS 变量（transform 层，60fps）
// - 一次手势 = 一次 onBack，状态锁防双重返回与残留
// - 仅触屏设备生效；桌面端完全不受影响
import { useEffect, useRef } from 'react'
import { SWIPE_BACK_EDGE_PX, shouldCompleteSwipe } from '../utils/swipeBack'

const IGNORE_SELECTOR = 'input, textarea, select, [contenteditable="true"], [data-swipe-back-ignore="true"]'

function isTouchDevice() {
  return navigator.maxTouchPoints > 0 || 'ontouchstart' in window
}

function prefersReducedMotion() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

const ACTIVE_CLASS = 'swipe-back-active'
const SETTLING_CLASS = 'swipe-back-settling'

// 动画参数（iOS 式）
const COMPLETE_MS = 220
const CANCEL_MS = 200
const PREV_PARALLAX_PX = 30

let prevLayerEl = null

function ensurePrevLayer() {
  if (prevLayerEl && document.getElementById('swipe-prev-layer') === prevLayerEl) return prevLayerEl
  prevLayerEl = document.getElementById('swipe-prev-layer')
  if (!prevLayerEl) {
    prevLayerEl = document.createElement('div')
    prevLayerEl.id = 'swipe-prev-layer'
    prevLayerEl.setAttribute('aria-hidden', 'true')
    document.body.appendChild(prevLayerEl)
  }
  return prevLayerEl
}

/** 递归同步滚动位置：快照克隆不保留 scrollTop/scrollLeft */
function syncScrollRecursive(srcNode, cloneNode) {
  if (!srcNode || !cloneNode) return
  if (srcNode.scrollTop || srcNode.scrollLeft) {
    cloneNode.scrollTop = srcNode.scrollTop
    cloneNode.scrollLeft = srcNode.scrollLeft
  }
  const srcKids = srcNode.children
  const cloneKids = cloneNode.children
  const len = Math.min(srcKids.length, cloneKids.length)
  for (let i = 0; i < len; i += 1) syncScrollRecursive(srcKids[i], cloneKids[i])
}

/** 捕获当前页 DOM 快照作为“上一页”（含 Header/内容区/底部导航，整体参与过渡） */
export function capturePrevPage() {
  const root = document.getElementById('root')
  const layer = ensurePrevLayer()
  if (!root || !layer) return
  const clone = root.cloneNode(true)
  clone.removeAttribute('id')
  clone.removeAttribute('style')
  syncScrollRecursive(root, clone)
  layer.replaceChildren(clone)
}

function setSwipeVisual({ x, progress, prevX }) {
  const root = document.documentElement
  const safe = Math.max(0, Math.min(1, progress))
  root.style.setProperty('--swipe-back-x', `${Math.max(0, x)}px`)
  root.style.setProperty('--swipe-back-progress', String(safe))
  root.style.setProperty('--swipe-prev-x', `${prevX}px`)
}

function clearSwipeVisual() {
  const root = document.documentElement
  root.classList.remove(ACTIVE_CLASS, SETTLING_CLASS)
  root.style.removeProperty('--swipe-back-x')
  root.style.removeProperty('--swipe-back-progress')
  root.style.removeProperty('--swipe-prev-x')
  // 清空上一页快照：视觉上已隐藏，但 DOM/文本仍残留会污染可访问性树与文本断言
  if (prevLayerEl) prevLayerEl.replaceChildren()
}

/**
 * 移动触屏设备左侧边缘右滑返回。
 * @returns {{ capture: () => void }} capture：在页面切换前调用，记录当前页为“上一页”
 */
export default function useSwipeBack({ enabled = true, onBack }) {
  const onBackRef = useRef(onBack)
  const gestureRef = useRef(null)
  const rafRef = useRef(0)
  const settleTimerRef = useRef(0)
  const animatingRef = useRef(false)

  useEffect(() => {
    onBackRef.current = onBack
  }, [onBack])

  useEffect(() => {
    if (!enabled || !isTouchDevice()) return undefined

    const cancelRaf = () => {
      if (rafRef.current) window.cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
    }

    const stopSettling = () => {
      animatingRef.current = false
      if (settleTimerRef.current) window.clearTimeout(settleTimerRef.current)
      settleTimerRef.current = 0
      cancelRaf()
      clearSwipeVisual()
    }

    const resetGesture = () => {
      gestureRef.current = null
    }

    /** 松手后收尾：complete=true 先播完退出动画再执行返回；否则回弹 */
    const settle = ({ complete = false, viewportWidth = 360 } = {}) => {
      const gesture = gestureRef.current
      resetGesture()
      if (!gesture?.horizontal) {
        stopSettling()
        return
      }
      animatingRef.current = true
      const root = document.documentElement
      root.classList.add(ACTIVE_CLASS, SETTLING_CLASS)

      if (complete) {
        // 当前页滑出屏幕，上一页回正（parallax → 0）
        setSwipeVisual({ x: viewportWidth, progress: 1, prevX: 0 })
        settleTimerRef.current = window.setTimeout(() => {
          // 动画播完才真正切换页面，避免“啪一下切换”
          onBackRef.current?.()
          // 等待 React 提交新页面后瞬间清理（此时 #root 内容与快照一致，无跳变）
          window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => stopSettling())
          })
        }, COMPLETE_MS)
      } else {
        // 未达阈值：回弹到原位，上一页恢复 parallax
        setSwipeVisual({ x: 0, progress: 0, prevX: -PREV_PARALLAX_PX })
        settleTimerRef.current = window.setTimeout(stopSettling, CANCEL_MS)
      }
    }

    const onTouchStart = (event) => {
      if (event.touches?.length !== 1) return resetGesture()
      if (animatingRef.current) return // 动画中忽略新手势，防连续快速触发
      const touch = event.touches[0]
      const target = event.target instanceof Element ? event.target : null
      if (touch.clientX > SWIPE_BACK_EDGE_PX || target?.closest(IGNORE_SELECTOR)) return resetGesture()
      gestureRef.current = {
        startX: touch.clientX,
        startY: touch.clientY,
        startedAt: Number(event.timeStamp) || performance.now(),
        horizontal: false,
        lastX: touch.clientX,
        lastT: Number(event.timeStamp) || performance.now(),
        vx: 0,
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
        if (!gesture.horizontal) {
          gesture.horizontal = true
          // 无障碍：系统减少动态效果时不做跟手动画，直接返回
          if (prefersReducedMotion()) {
            onBackRef.current?.()
            resetGesture()
            return
          }
          document.documentElement.classList.add(ACTIVE_CLASS)
        }
        // 瞬时速度：最近两次 move 的位移 / 时间（touchend 时取用，快速甩动判定）
        // 使用事件时间戳，而不是处理函数实际获得 CPU 的时间；主线程短暂繁忙时，
        // 后者会把一次真实快速甩动误判为慢拖拽。
        const now = Number(event.timeStamp) || performance.now()
        const dtMs = now - gesture.lastT
        if (dtMs > 0) {
          gesture.vx = (touch.clientX - gesture.lastX) / dtMs
        }
        gesture.lastX = touch.clientX
        gesture.lastT = now
        const viewportWidth = Math.max(window.innerWidth, 320)
        // rAF 合并高频 move，直接写 transform（无 transition，1:1 跟手）
        cancelRaf()
        rafRef.current = window.requestAnimationFrame(() => {
          rafRef.current = 0
          const cur = gestureRef.current
          if (!cur?.horizontal) return
          const curDx = touch.clientX - cur.startX
          const progress = Math.min(1, Math.max(0, curDx / viewportWidth))
          // 当前页 1:1 跟手；上一页轻微 parallax（-30px → 0）
          setSwipeVisual({
            x: Math.max(0, curDx),
            progress,
            prevX: -PREV_PARALLAX_PX * (1 - progress),
          })
        })
        if (event.cancelable) event.preventDefault()
      }
    }

    const onTouchEnd = (event) => {
      const gesture = gestureRef.current
      const touch = event.changedTouches?.[0]
      if (!gesture?.horizontal || !touch) return resetGesture()
      const dx = touch.clientX - gesture.startX
      const viewportWidth = Math.max(window.innerWidth, 320)
      // 速度取最近两次 move 的瞬时速度（touchend 与最后 move 同位置时依然有效）
      const velocityX = gesture.vx || 0
      const complete = shouldCompleteSwipe({ dx, viewportWidth, velocityX })
      settle({ complete, viewportWidth })
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
      animatingRef.current = false
      if (settleTimerRef.current) window.clearTimeout(settleTimerRef.current)
      settleTimerRef.current = 0
      cancelRaf()
      resetGesture()
      // 返回动作可能导致组件立即卸载；若正在收尾动画则留给计时器清理，否则立即清理
      clearSwipeVisual()
    }
  }, [enabled])

  return { capture: capturePrevPage }
}
