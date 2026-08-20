# BUDU Dashboard

BUDU 甜品门店管理系统 · 首页概览 Dashboard（React 18 + Vite + Tailwind CSS 3 + Recharts + lucide-react）

## 快速开始

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # 生产构建
```

## 数据来源

- 门店、每日业绩、POS、库存、订单、工资和审批数据来自云端业务接口。
- 经营分析上传由服务端解析并保存，不再随前端打包旧月份静态报表。
- 页面顶部的日期、自然周、月份和门店筛选会联动首页及经营分析。

## 说明

- 商品 TOP10 来自云端商品销售汇总（已剔除「赠品 / 临时商品」类目），随周期和门店筛选联动。
- 员工绩效基于每日值班、营业数据与当前工资规则实时计算。

## 目录结构

```
budu/
├── src/
│   ├── App.jsx                # 布局 + 门店/月份筛选状态
│   ├── data/
│   │   └── baseStores.js      # 轻量门店身份配置（不含经营数据）
│   ├── utils/
│   │   ├── selectors.js       # 筛选/汇总/环比/KPI/排行/提醒计算
│   │   └── format.js          # 数字与排名样式工具
│   └── components/
│       ├── Sidebar.jsx
│       ├── Header.jsx         # 月份 + 门店下拉
│       ├── Card.jsx
│       ├── StoreRankingTable.jsx
│       ├── RevenueTrendChart.jsx
│       ├── ChannelChart.jsx   # 渠道销售构成（店内/美团/闪购）
│       ├── EmployeePerformanceTable.jsx
│       └── ProductSalesTable.jsx
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
