export const SWIPE_BACK_EDGE_PX = 36
export const SWIPE_BACK_DISTANCE_PX = 72
export const SWIPE_BACK_MAX_DURATION_MS = 900

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

