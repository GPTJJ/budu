/**
 * BuduSuccessFeedback — 卡皮巴拉提交成功反馈（统一品牌级成功动效）
 * 纯前端 inline SVG + CSS animation；业务数据/后端/API 零改动。
 *
 * 时间轴（固定 ≈2.7s，封装在本组件内，业务页不散落 setTimeout）：
 *   0ms          操作成功（组件收到 open）
 *   0—675ms     仍闭眼（刚被叫醒）
 *   675—865ms   慢慢睁眼
 *   865—1860ms  保持睁眼；1100—1800ms 完成轻微点头
 *   1500ms      ✓ 出现
 *   1860—2050ms 重新闭眼
 *   2200ms      回到安心睡觉
 *   2700ms      动画结束 → successComplete
 *
 * 触发规则：
 *   - 仅服务端真实成功后由业务页 open
 *   - 动画播放中重复收到同一次成功事件：忽略（不重复触发）
 *   - API 失败 / 危险操作确认前：业务页不得 open（本组件不处理失败）
 *
 * 无障碍：prefers-reduced-motion 用户直接显示闭眼卡皮巴拉 + 结果；结果区 aria-live="polite"。
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { t } from '../../utils/text'

const ANIM_MS = 2700
const HOLD_MS = 420 // 动画结束后停留
const CLOSE_MS = 220 // 淡出

/** 组件内部状态机：idle → animating → complete → closing */
export default function BuduSuccessFeedback({
  open = false,
  title = t('提交成功'),
  description = '',
  autoClose = true,
  onClose,
  primaryAction,
  secondaryAction,
}) {
  const [stage, setStage] = useState('idle') // idle | animating | complete | closing
  const timers = useRef([])
  const stageRef = useRef('idle')

  const setStageSafe = (next) => {
    stageRef.current = next
    setStage(next)
  }

  // open 触发：仅 idle 状态接受（重复触发保护）
  useEffect(() => {
    if (!open) return undefined
    if (stageRef.current !== 'idle') return undefined
    const list = timers.current
    const reducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reducedMotion) {
      // 无障碍：减少动画用户直接显示闭眼卡皮巴拉 + 结果，跳过完整时间轴
      setStageSafe('complete')
      if (autoClose) {
        list.push(setTimeout(() => setStageSafe('closing'), 1600))
        list.push(setTimeout(() => {
          setStageSafe('idle')
          onClose?.()
        }, 1600 + CLOSE_MS))
      }
      return () => list.forEach(clearTimeout)
    }
    setStageSafe('animating')
    list.push(setTimeout(() => setStageSafe('complete'), ANIM_MS))
    if (autoClose) {
      list.push(setTimeout(() => setStageSafe('closing'), ANIM_MS + HOLD_MS))
      list.push(setTimeout(() => {
        setStageSafe('idle')
        onClose?.()
      }, ANIM_MS + HOLD_MS + CLOSE_MS))
    }
    return () => list.forEach(clearTimeout)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 组件卸载清理定时器
  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  if (stage === 'idle') return null

  return createPortal(
    <div
      className={`budu-feedback-overlay ${stage === 'closing' ? 'budu-feedback-closing' : ''}`}
      style={{ '--budu-feedback-anim': `${ANIM_MS}ms` }}
      role="presentation"
    >
      <div className="budu-feedback-card" data-stage={stage} role="dialog" aria-modal="true" aria-label={title}>
        {/* 卡皮巴拉（Golden Reference SVG，几何严格固定） */}
        <svg className={`budu-capy${stage === 'animating' ? ' budu-capy--animating' : ''}`} viewBox="0 0 420 270" role="img" aria-label="budu 卡皮巴拉提交成功动画">
          {/* 睡觉 Z */}
          <g
            className="budu-capy__sleep-z"
            fill="none"
            stroke="#102C6A"
            strokeWidth="7"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M320 45h28l-28 27h28" />
            <path d="M355 19h20l-20 19h20" opacity=".7" />
          </g>
          {/* 红色底部阴影 */}
          <ellipse cx="214" cy="228" rx="150" ry="18" fill="#FF5953" opacity=".95" />
          {/* 主身体 */}
          <g
            fill="#FCFCFA"
            stroke="#102C6A"
            strokeWidth="8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M90 178c-9-43 8-86 49-109 28-16 65-23 113-20 69 4 116 50 116 114v20c0 30-17 43-46 43H140c-27 0-45-17-50-48z" />
            <path d="M131 79c-1-20 4-31 15-31 12 0 17 12 16 32" />
            <path d="M188 75c2-18 10-29 21-27 12 2 15 14 10 31" />
            <path d="M284 211c0-18 15-29 36-29" />
            <path d="M142 210c0-18 17-29 38-29 20 0 34 11 35 29" />
          </g>
          {/* 耳朵红色细节 */}
          <path d="M186 65c7-11 15-15 24-13" fill="none" stroke="#FF4343" strokeWidth="8" strokeLinecap="round" />
          {/* 红脸颊 */}
          <circle cx="143" cy="139" r="15" fill="#FF4343" />
          {/* 鼻子 / 嘴 */}
          <g fill="none" stroke="#102C6A" strokeWidth="8" strokeLinecap="round">
            <path d="M83 127c8-8 15-9 23-2" />
            <path d="M89 128v29" />
            <path d="M90 158c2 7 7 12 14 15" />
          </g>
          {/* 闭眼 */}
          <g
            className="budu-capy__eye-closed"
            fill="none"
            stroke="#102C6A"
            strokeWidth="8"
            strokeLinecap="round"
          >
            <path d="M122 120h22" />
          </g>
          {/* 睁眼 */}
          <g className="budu-capy__eye-open">
            <circle cx="133" cy="120" r="8" fill="#102C6A" />
            <circle cx="136" cy="117" r="2.6" fill="#FFFFFF" />
          </g>
          {/* 成功 ✓ */}
          <g className="budu-capy__success-mark" transform="translate(260 76)">
            <circle cx="0" cy="0" r="25" fill="#FFFFFF" stroke="#102C6A" strokeWidth="6" />
            <path
              d="M-11 0l8 8 16-18"
              fill="none"
              stroke="#FF4343"
              strokeWidth="7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </g>
        </svg>

        {/* 成功结果（aria-live 播报） */}
        <div className="budu-feedback-body" aria-live="polite">
          <h3 className="budu-feedback-title">{title}</h3>
          {description && <p className="budu-feedback-desc">{description}</p>}
          {(primaryAction || secondaryAction) && (
            <div className="budu-feedback-actions">
              {secondaryAction && (
                <button type="button" className="budu-feedback-btn budu-feedback-btn-secondary" onClick={secondaryAction.onClick}>
                  {secondaryAction.label}
                </button>
              )}
              {primaryAction && (
                <button type="button" className="budu-feedback-btn budu-feedback-btn-primary" onClick={primaryAction.onClick}>
                  {primaryAction.label}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
