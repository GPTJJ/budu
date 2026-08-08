# BUDU UI 设计基线（2026-08 · Apple 式企业级方向）

## 方向

- 定位：甜品类门店日常管理工具，使用者每天重复操作。
- 基调：中性浅灰背景 + 低饱和 budu 粉唯一强调色；安静、克制、现代、易扫读。
- 原则：先可扫读后装饰；动效 150–250ms；手机端触控区不小于 40×44px；数字用 tabular-nums。

## 设计令牌

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `canvas` | `#F5F5F7` | 全局页面背景（中性浅灰） |
| `surface` | `#FFFFFF` | 卡片/浮层表面 |
| `border` | `#E5E5EA` | 细分割线/描边 |
| `budu-500` | `#BC4F7E` | 唯一强调色（低饱和粉） |
| `budu-50/100` | `#FBF1F6 / #F7E2EC` | 选中态浅底、柔和标签 |
| 卡片 | `rounded-2xl`（移动端 `rounded-xl`）+ `shadow-card` + 细边框 | 统一容器 |
| 输入框 | `.input`（圆角 10px、高 40px、聚焦粉色描边） | 全部表单控件 |
| 按钮 | `.btn-primary / .btn-secondary / .btn-ghost / .btn-danger` | 统一按钮层级 |
| 状态标签 | `.tag` + emerald/amber/rose/slate 50 底 700 字 | 统一状态色 |
| 聚焦态 | 2px `#BC4F7E` 外框 + 2px 偏移 | 键盘/无障碍导航 |

## 规则

1. 禁止渐变主色：按钮、图标、选中态一律纯色；不再使用 `bg-gradient-to-*` 与 grape 紫做主视觉。
2. 阴影极浅且中性（黑 alpha 4%–8%），层级靠背景与细边框；禁止大面积彩色阴影。
3. 嵌套圆角遵循“外层半径 = 内层半径 + padding”；避免卡片套卡片。
4. 标题与短文案 `text-wrap: balance`；数字统一 `tabular-nums`；数据字体用 semibold，避免 extrabold/black。
5. 交互控件键盘聚焦必须有可见 `:focus-visible`；尊重 `prefers-reduced-motion`。
6. 移动端输入框字号 ≥16px，防止 iOS 聚焦缩放；底部导航/侧栏触控区 ≥40px。
7. 每个操作区一个主要 CTA，其余用 Secondary/Ghost/Danger。
8. 图片边缘加 1px 中性内描边。

## 本次变更范围

- 仅样式与防护层：令牌、全局类、Sidebar/Header/底部导航、Dashboard 指标层级、图表换肤、按钮去渐变、字体收敛。
- 不触碰：业务计算、数据模型、权限、API、导出内容、消息推送、图片上传、PWA 逻辑、路由/视图切换逻辑。
