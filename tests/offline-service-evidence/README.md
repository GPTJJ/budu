# budu 门店服务 UI 验证

此目录截图使用 `tests/offline-service-harness.jsx` 的合成资料，接口由测试替身提供。
截图及 UI 自动化不证明真实微信发送、真实二维码扫描、小程序真机或服务端权限验证通过。

- 新 UI：`node node_modules/@playwright/test/cli.js test --config tests/offline-service.playwright.config.mjs`
- 兼容 UI：`node node_modules/@playwright/test/cli.js test tests/mailing.spec.mjs tests/invoice.spec.mjs tests/customer-request.spec.mjs --config playwright.config.mjs --workers=1`
- 页面：启动 Vite 后访问 `/tests/offline-service-harness.html`，开票页加 `?page=invoice`。
- 浏览器：安装的 Playwright WebKit；Chromium 项目使用本机 Google Chrome channel。
- 宽度：320、340、375、390、430、768、1280 px。
- 覆盖：接收确认与已开票区分、旧已开票保留、必填运单、配送凭证、更正原因、重复点击、响应丢失恢复、不同角色入口、二维码开关及错误态、通知状态、关联购买指标口径、长资料与弹层滚动。
- 可视高度缩小测试仅验证浏览器内滚动行为，不代替 iPhone 软件键盘或真实 iPad 验收。

实际运行结果及平台未验证项以本任务总报告为准。

## 2026-10-24 本轮结果

- 新功能 UI：首批 28 项全过；新增可视高度缩小 2 项通过、旧 H5 生成/取消/历史发货 2 项通过，共 32 个独立浏览器用例。运单校验与服务端对齐后另复验 2 项通过。
- 原有兼容套件启动 42 项：18 项通过，6 项失败，随后停止重复已知夹具错误；1 项中断、17 项未运行。不能将该套件标为全量通过。
- 原套件失败原因：`mailing-harness.html` 未提供 `storesAuthority: postgresql`，现有门店门禁禁用了新建；5 个发票安全删除断言仅接受根滚动样式 `hidden`，现有 `OverlayPrimitives` 已采用 `hidden scroll` 保留桌面滚动条。本任务没有改动这些门禁、滚动实现或旧夹具。
- 上述旧 H5 业务路径改在本任务显式提供合成 PostgreSQL 门店目录的夹具中验证，通过；没有通过放开门店门禁或删除保护来修测试。
- 本机缺少 Playwright 默认 Chromium headless shell，切到已安装的 Google Chrome 后 Chromium 用例通过。没有下载浏览器或改变用户浏览器设置。
- 原生 iPhone/iPad、真实微信提醒、正式/体验小程序码扫描未在这些 UI 测试中执行。
