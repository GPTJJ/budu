# BUDU Dashboard

BUDU 甜品门店管理系统 · 首页概览 Dashboard（React 18 + Vite + Tailwind CSS 3 + Recharts + lucide-react）

## 快速开始

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # 生产构建
```

## 数据来源与更新

- 报表文件位于 `C:\Users\Administrator\Desktop\budu OS文档\`：
  - `三店4月份.xlsx` ~ `三店7月份.xlsx`（综合营业统计：每日营业额/订单/渠道/支付/菜品销量）
  - `budu薪资表(总）.xlsx`（2026.27周 ~ 2026.31周：员工工资/工时/提成/考评）
- 数据由脚本自动解析生成，**不要手动修改** `src/data/reportData.js`：

```bash
python scripts/build_report_data.py
```

- 更新报表后重新运行脚本，再刷新页面即可生效。
- 页面顶部的「月份 + 门店」下拉会联动刷新全部模块：
  KPI 卡片、门店排行、营业额趋势、渠道构成、员工绩效、商品销售、重要提醒。

## 说明

- 商品 TOP10 来自菜品明细报表的真实单品数据（已剔除「赠品 / 临时商品」类目），随月份 + 门店下拉联动。
- 员工绩效基于薪资表 5 周合计：当班营业额 = 出勤日门店营业额合计，ROI = 当班营业额 / 工资。

## 目录结构

```
budu/
├── scripts/
│   └── build_report_data.py   # Excel -> reportData.js 生成脚本
├── src/
│   ├── App.jsx                # 布局 + 门店/月份筛选状态
│   ├── data/
│   │   └── reportData.js      # 自动生成的真实数据模块
│   ├── utils/
│   │   ├── selectors.js       # 筛选/汇总/环比/KPI/排行/提醒计算
│   │   └── format.js          # 数字与排名样式工具
│   └── components/
│       ├── Sidebar.jsx
│       ├── Header.jsx         # 月份 + 门店下拉
│       ├── Card.jsx
│       ├── KpiCard.jsx
│       ├── StoreRankingTable.jsx
│       ├── RevenueTrendChart.jsx
│       ├── ChannelChart.jsx   # 渠道销售构成（店内/美团/闪购）
│       ├── EmployeePerformanceTable.jsx
│       ├── ProductSalesTable.jsx
│       └── NotificationPanel.jsx
```

## 门店映射

| 报表门店 | 页面显示 |
| --- | --- |
| budu（三里屯通盈店） | 北京通盈中心店 |
| budu（官舍店） | 北京官舍店 |
| budu（西单更新场店） | 北京西单店 |

## 登录与多设备分享（v2）

本应用已升级为「账号登录 + 共享数据库」模式：

```bash
npm install
npm run build      # 构建前端
npm run server     # 启动服务 http://localhost:3000
```

- 第一个注册的账号自动成为管理员；
- 业绩录入与员工名单全团队共享（多设备同步）；
- 部署与公网分享方式详见 [DEPLOY.md](DEPLOY.md)。
