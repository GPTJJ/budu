# budu Mobile Swipe Back 优化报告

> 提交：`77d3caa`（分支 `feat/wecom-push`）· 2026-08-23
> 目标：移动端右滑返回从「触发式页面跳转动画」升级为「手势驱动的 Interactive Page Transition」（接近 iOS interactivePopGestureRecognizer）
> 范围：纯前端交互与动画；未改动 PostgreSQL / Prisma / 后端 API / 登录 / 权限 / 业务数据 / 路由业务含义 / 桌面端

---

## 1. 原问题根因

修改前（录屏可复现）：

1. **上一页不参与动画**：右滑时只有 `#root`（当前页）整体右移，左侧露出的是 **body 粉色渐变背景**，没有真实上一页内容——这是"网页抽屉感"的主要来源。
2. **松手瞬间先切页再动画**：旧实现 `touchend → onBack()（切换 view）→ 再播回位动画`，且切换后 `#root` 内容已替换为新页面，视觉上就是"啪一下切换"。
3. **非 1:1 跟手**：位移带阻尼系数 `dx * (0.92 - progress * 0.14)`，手指与页面之间缺乏连续感。
4. **抽屉化视觉**：`scale(1 - progress*0.012)` + `border-radius 20px` + ‹ 圆形指示器 + 重阴影，偏离 iOS 整页平移语义。
5. **返回目标固定为首页**：任何二级页右滑都回 overview，与"上一页"直觉不符，也无法支撑三级页逐级返回。

---

## 2. 修改文件

| 文件 | 改动 |
|---|---|
| `src/hooks/useSwipeBack.js` | 重写：双层快照层管理、手势状态机、rAF 合并、距离+速度判定、完成/取消动画、防双重锁、reduced-motion、快照捕获导出 |
| `src/index.css` | 重写 swipe-back 样式：`#swipe-prev-layer` 上一页层、当前页轻阴影、settling 过渡；删除粉色渐变/缩放/圆角/指示器 |
| `src/utils/swipeBack.js` | 新增 `shouldCompleteSwipe`（距离+速度统一判定）与阈值常量导出 |
| `src/components/Dashboard.jsx` | 轻量页面栈 `viewStackRef`（右滑返回真正的上一页）、`handleNavigate` 时捕获上一页快照、`handleSwipeBack` 栈式返回 |
| `scripts/test-swipe-back.mjs` | 单元测试扩展（阈值/速度/边界） |
| `tests/swipe-back-harness.html` | 新增：完整 Dashboard + mock API 的 E2E 载体（可切桌面/移动模式） |
| `tests/swipe-back.spec.mjs` | 新增：11 项手势 E2E |
| `playwright.config.mjs` | 注册新 spec |

---

## 3. 新交互模型

```
touchstart（左边缘 36px 内、单指、非输入元素、非动画中）
  → 记录起点/起点时间
touchmove
  → 方向判定：dx>12 且 |dx|>|dy|*1.2 才进入横向手势（纵向滚动不误触）
  → 进入后：加 .swipe-back-active，当前页 transform 直接 = 手指位移（无 transition）
  → 上一页快照从 translateX(-30px) 随 progress 回正
  → 每次 move 记录瞬时速度 vx（最近两点位移/时间）
  → rAF 合并写 CSS 变量（不触发 React 渲染）
touchend
  → progress = dx / viewportWidth
  → complete = progress ≥ 0.28 OR (vx ≥ 0.5px/ms 且 dx ≥ 24px)
  → complete：播完成动画（当前页滑至 100vw、上一页回正 0）
               → 220ms 动画结束 → 执行 handleSwipeBack（pop 页面栈）
               → React 提交后瞬间清理（无跳变）
  → cancel：回弹动画（当前页 → 0、上一页 → -30px）→ 200ms 后清理
touchcancel → 按取消处理
```

关键时序保证：**动画播完才执行路由返回**，一次手势 = 一次 onBack（animating 锁）。

---

## 4. Previous Page 实现

- **快照捕获**：`handleNavigate` 切换 view 前调用 `swipeBack.capture()`，将当前 `#root` 的 DOM **深克隆**（`cloneNode(true)`，去 id/style，递归同步滚动位置）放入 `#swipe-prev-layer`。
- **层级**：`#swipe-prev-layer`（fixed inset-0，z-index 1，默认 `visibility:hidden`）← 上一页；`#root`（z-index 2）← 当前页。手势开始时上一页层 `visibility:visible` 并随 parallax 移动。
- **内容完整性**：克隆的是整个 `#root`（Header + 内容区 + 底部导航整体），因此上一页底部导航、Header 都真实参与过渡。
- **性能**：克隆仅发生在页面切换时（一次），手势期间零克隆；快照层 `pointer-events:none`，无交互成本。
- **清理**：动画结束后 `replaceChildren()` 清空快照，避免残留 DOM 污染可访问性树。

---

## 5. 动画参数（最终采用）

| 参数 | 值 |
|---|---|
| Edge width（触发边缘） | 36px（左侧） |
| Distance threshold | progress ≥ 0.28（屏宽比例） |
| Velocity threshold | ≥ 0.5 px/ms（500px/s）且 dx ≥ 24px |
| Completion duration | 220ms |
| Cancel duration | 200ms |
| Easing | `cubic-bezier(0.22, 0.61, 0.36, 1)`（iOS deceleration 近似） |
| Previous-page parallax | -30px → 0（`-30 * (1 - progress)`） |
| 当前页阴影 | `-8px 0 20px rgba(0,0,0, progress*0.06)`（随进度淡入，极轻） |
| 跟手 | 1:1（translateX = dx，无阻尼） |

---

## 6. 性能处理

- 手势期间只写 **CSS 变量 + transform: translate3d**（GPU 合成层），零 Layout/Reflow
- `touchmove` 高频事件经 **requestAnimationFrame 合并**（每帧最多一次样式写入）
- 位置/状态存于 **ref**（gestureRef），不触发 React setState/重渲染
- `will-change: transform` 预声明；`backface-visibility` 由 transform 层隐含
- 快照克隆仅在页面切换时执行一次，手势中无 DOM 操作

---

## 7. 风险与兼容

| 项 | 结论 |
|---|---|
| Router / Browser History | 未改动；view 栈是组件内 ref，不触碰 history API（POS `#pos` hash 逻辑保留） |
| Mobile Safari / WebView | window 级 touch 监听 + 确认横向后 `preventDefault`；PWA/standalone 无边缘手势冲突；`prefers-reduced-motion` 时直接返回无动画 |
| Swiper / 横向组件 | 左边缘 36px 起手才触发；纵向滚动（|dy|>18 且 >|dx|）立即取消；`IGNORE_SELECTOR`（input/textarea/select/contenteditable/data-swipe-back-ignore）跳过 |
| 桌面端 | `isTouchDevice()` 门控，鼠标/侧栏/布局完全不变（E2E 桌面模式验证无 swipe 层） |
| 连续操作 | `animatingRef` 锁：动画期间新手势忽略；完成后清空快照与 transform，无残留/双重返回 |
| 既有 swipe 依赖 | pos-ipad.spec 的右滑测试（扫码页返回）通过，行为兼容 |

---

## 8. 测试结果

**单元**（`scripts/test-swipe-back.mjs`，7 项）：边缘判定、方向、慢拖距离阈值、快速甩动速度阈值、速度慢距离不足回弹、负位移。

**E2E**（`tests/swipe-back.spec.mjs`，11 项，webkit + 手机视口，完整 Dashboard）：

| 场景 | 结果 |
|---|---|
| 拖动中 1:1 跟手（120px 位移 → x=120px）+ 上一页快照可见（含底部导航） | ✅ |
| 慢速拖过阈值 → 完成动画（settling 中 x>300px）后回到上一页，无突然切页 | ✅ |
| 未达阈值 → 自然回弹，不返回 | ✅ |
| 快速甩动（60px、高速）→ 返回 | ✅ |
| 取消手势（拖出 160px 又拖回 20px）→ 不返回 | ✅ |
| 纵向滚动不误触返回 | ✅ |
| 非左边缘起手不触发 | ✅ |
| 三级页栈：雇员 → 员工档案 → 返回雇员 → 返回首页 | ✅ |
| 首页（一级页）不触发右滑返回 | ✅ |
| 防双重返回（返回后动画期再滑不重复触发） | ✅ |
| 桌面模式无 swipe 层 | ✅ |

**全量回归**：node 28/28 PASS；Playwright 55/55 PASS（含既有 pos-ipad 右滑测试）。

---

## 9. 录屏路径复测对照（修改前 → 后）

1. 左侧大面积粉色背景 → **上一页真实内容从手势开始即露出**（快照层）
2. 上一页不参与 → **Header + 内容 + 底部导航整体 parallax 参与**
3. 页面不跟手 → **1:1 跟手，手指停页面停**
4. 松手突然切页 → **完成动画播完（当前页滑出、上一页回正）后才切页，无跳变**
5. 快速滑动 → 速度阈值判定返回，**无双重返回**
6. 取消手势 → **自然回弹，无残留**（快照清理）
