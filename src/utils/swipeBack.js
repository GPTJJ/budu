// 右滑返回手势参数与判定（移动端 Interactive Pop Gesture）

export const SWIPE_BACK_EDGE_PX = 36 // 左侧触发边缘宽度（px）
export const SWIPE_BACK_DISTANCE_PX = 72 // 最小横向位移（px）
export const SWIPE_BACK_MAX_DURATION_MS = 900 // 手势最大时长（ms）
export const SWIPE_BACK_PROGRESS_THRESHOLD = 0.28 // 松手进度阈值（屏宽比例）
export const SWIPE_BACK_VELOCITY_THRESHOLD_PX_MS = 0.5 // 快速甩动速度阈值（px/ms）
export const SWIPE_BACK_MIN_FLING_PX = 24 // 快速甩动最小位移（px）

/**
 * 手势基础判定：起手位置在左边缘、横向为主、位移足够、时长合理。
 * 返回是否完成由 shouldCompleteSwipe（距离 + 速度）最终决定。
 */
export function isSwipeBackGesture({
  startX,
  startY,
  endX,
  endY,
  duration,
  edgeWidth = SWIPE_BACK_EDGE_PX,
  minDistance = SWIPE_BACK_DISTANCE_PX,
}) {
  const dx = endX - startX
  const dy = endY - startY
  return startX >= 0
    && startX <= edgeWidth
    && dx >= minDistance
    && Math.abs(dx) >= Math.abs(dy) * 1.5
    && duration >= 0
    && duration <= SWIPE_BACK_MAX_DURATION_MS
}

/**
 * 松手完成判定：慢速拖拽看距离（progress ≥ 28%），快速甩动看速度。
 * @param {object} p
 * @param {number} p.dx 总横向位移
 * @param {number} p.viewportWidth 视口宽度
 * @param {number} p.velocityX 松手瞬间速度（px/ms）
 */
export function shouldCompleteSwipe({
  dx,
  viewportWidth,
  velocityX = 0,
  progressThreshold = SWIPE_BACK_PROGRESS_THRESHOLD,
  velocityThreshold = SWIPE_BACK_VELOCITY_THRESHOLD_PX_MS,
  minFlingPx = SWIPE_BACK_MIN_FLING_PX,
}) {
  const progress = Math.min(1, Math.max(0, dx / Math.max(viewportWidth, 1)))
  return progress >= progressThreshold || (velocityX >= velocityThreshold && dx >= minFlingPx)
}
