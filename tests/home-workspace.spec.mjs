import { expect, test } from '@playwright/test'

const activityRows = [
  {
    id: 'notice-1',
    templateKey: 'approval_result',
    title: '报销审批已通过 1195.59 元',
    content: '测试报销申请 ¥1,280.00 已入账，共 2 单',
    priority: 'normal',
    status: 'unread',
    target: 'approval',
    refType: 'approval',
    createdAt: '2026-08-20T10:21:00.000Z',
  },
  {
    id: 'notice-2',
    templateKey: 'payroll_pending',
    title: '工资条待签收',
    content: '实发 5680.00 元，请及时核对工资条',
    priority: 'high',
    status: 'unread',
    target: 'staff-payroll',
    refType: 'payroll',
    createdAt: '2026-08-20T09:10:00.000Z',
  },
]

const storeDirectoryRows = [
  { key: 'tongying', name: '北京通盈中心店', district: '朝阳区 · 三里屯', active: true, statusHistory: [] },
  { key: 'guanshe', name: '北京官舍店', district: '朝阳区 · 亮马桥', active: true, statusHistory: [] },
  { key: 'chaowai', name: '北京朝外店', district: '朝阳区 · 朝外', active: false, statusHistory: [] },
  { key: 'xidan', name: '北京西单店', district: '西城区 · 西单', active: true, statusHistory: [] },
]

const analysisFixture = {
  daily: {
    '2026-08': {
      tongying: [{ d: '08-20', inc: 12800, ord: 128, dish: 186, dis: 320, rev: 13120 }],
      guanshe: [{ d: '08-20', inc: 6800, ord: 72, dish: 95, dis: 120, rev: 6920 }],
      chaowai: [{ d: '08-20', inc: 5300, ord: 60, dish: 80, dis: 80, rev: 5380 }],
    },
    '2026-11': {
      tongying: [{ d: '11-20', inc: 1800, ord: 20, dish: 30, dis: 0, rev: 1800 }],
      guanshe: [{ d: '11-20', inc: 1200, ord: 15, dish: 22, dis: 0, rev: 1200 }],
    },
  },
}

const dailyEntryRows = [
  { date: '2026-08-20', storeKey: 'tongying', incCents: 1280000, ord: 128, staffNames: ['测试员工'], status: 'confirmed', version: 1 },
  { date: '2026-08-20', storeKey: 'guanshe', incCents: 680000, ord: 72, staffNames: ['测试员工'], status: 'confirmed', version: 1 },
  { date: '2026-08-20', storeKey: 'chaowai', incCents: 530000, ord: 60, staffNames: ['测试员工'], status: 'confirmed', version: 1 },
  { date: '2026-11-20', storeKey: 'tongying', incCents: 180000, ord: 20, staffNames: ['测试员工'], status: 'confirmed', version: 1 },
  { date: '2026-11-20', storeKey: 'guanshe', incCents: 120000, ord: 15, staffNames: ['测试员工'], status: 'confirmed', version: 1 },
]

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/userdata') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ entries: {}, staff: [], stores: storeDirectoryRows, storesAuthority: 'postgresql', analysis: analysisFixture }),
      })
    }
    if (url.pathname.endsWith('/v2/stores')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rows: storeDirectoryRows }) })
    }
    if (url.pathname.endsWith('/daily-entries')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rows: dailyEntryRows }) })
    }
    if (url.pathname.endsWith('/approvals/requests')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rows: [{ id: 'a1' }, { id: 'a2' }] }) })
    }
    if (url.pathname.endsWith('/notifications')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rows: activityRows }) })
    }
    if (url.pathname.endsWith('/stock/alerts')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rows: [{ storeKey: 'tongying', itemId: 'p1', name: '测试商品', quantity: 1, minQty: 3 }] }) })
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rows: [] }) })
  })
})

for (const width of [320, 340, 375, 390, 430]) {
  test(`${width}px 首页无横向溢出且首屏可见经营与待办`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await page.goto('/tests/home-workspace-harness.html')
    await expect(page.getByText(/[今当]日经营状态/)).toBeVisible()
    await expect(page.getByText('待办事项')).toBeVisible()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    const toolbar = page.getByTestId('overview-toolbar')
    const toolbarLayout = await toolbar.evaluate((element) => {
      const storePicker = element.querySelector('[data-testid="overview-store-picker"]')
      const toolbarRect = element.getBoundingClientRect()
      const storeRect = storePicker.getBoundingClientRect()
      return {
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        toolbarLeft: toolbarRect.left,
        toolbarRight: toolbarRect.right,
        storeLeft: storeRect.left,
        storeRight: storeRect.right,
        viewportWidth: window.innerWidth,
      }
    })
    expect(toolbarLayout.scrollWidth).toBeLessThanOrEqual(toolbarLayout.clientWidth)
    expect(toolbarLayout.toolbarLeft).toBeGreaterThanOrEqual(0)
    expect(toolbarLayout.toolbarRight).toBeLessThanOrEqual(toolbarLayout.viewportWidth)
    expect(toolbarLayout.storeLeft).toBeGreaterThanOrEqual(0)
    expect(toolbarLayout.storeRight).toBeLessThanOrEqual(toolbarLayout.viewportWidth)
    const todoTop = await page.getByText('待办事项').boundingBox()
    expect(todoTop?.y).toBeLessThan(844)
  })
}

test('防窥默认开启、按住偷看、顶部眼睛切换、Shift+H 与 30 秒无操作自动重锁', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-08-20T10:00:00+08:00') })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/tests/home-workspace-harness.html')

  // 1. 默认开启防窥：可见录入进度、订单数、销量、目标达成率，隐藏真实 ¥ 金额，动态金额脱敏
  const statusCard = page.getByTestId('operations-status-card')
  await expect(statusCard).toContainText('3/4 已录入')
  await expect(statusCard).toContainText('260 单')
  await expect(statusCard).toContainText('361 件')
  await expect(statusCard).toContainText('今日目标达成率')
  await expect(page.getByTestId('revenue-details-panel')).toHaveCount(0)
  await expect(page.getByTestId('home-store-section')).not.toContainText('¥12,800.00')
  await expect(page.getByTestId('home-store-section')).toContainText('目标 640%')
  await expect(page.getByTestId('home-store-section')).toContainText('已录入 · 128 单')
  await expect(page.getByTestId('home-activity-section')).toContainText('报销审批已通过 •••• 元')
  await expect(page.getByTestId('home-activity-section')).toContainText('测试报销申请 •••• 元 已入账，共 2 单')
  await expect(page.getByTestId('home-activity-section')).not.toContainText('1195.59')
  await expect(page.getByTestId('home-activity-section')).not.toContainText('1,280.00')

  // 2. 按住偷看（按下显示金额，移出 / 松开均立即恢复隐藏）
  const peekBtn = page.getByTestId('peek-revenue-btn')
  await peekBtn.scrollIntoViewIfNeeded()
  const box = await peekBtn.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await expect(page.getByTestId('revenue-details-panel')).toBeVisible()
  await expect(page.getByTestId('revenue-details-panel')).toContainText('¥24,900.00')
  // 移出按钮区域立刻恢复隐藏
  await page.mouse.move(8, 8)
  await expect(page.getByTestId('revenue-details-panel')).toHaveCount(0)
  await page.mouse.up()
  // 再次按下并原地松开，立刻恢复隐藏
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await expect(page.getByTestId('revenue-details-panel')).toBeVisible()
  await page.mouse.up()
  await expect(page.getByTestId('revenue-details-panel')).toHaveCount(0)

  // 验证长按防选字样式与页面失焦 / visibilitychange 兜底回锁
  const peekStyles = await peekBtn.evaluate((el) => {
    const cs = window.getComputedStyle(el)
    return {
      userSelect: cs.userSelect || cs.webkitUserSelect,
      touchAction: cs.touchAction,
      hasNoCalloutClass: el.classList.contains('budu-no-callout'),
    }
  })
  expect(peekStyles.userSelect).toBe('none')
  expect(peekStyles.touchAction).toBe('manipulation')
  expect(peekStyles.hasNoCalloutClass).toBe(true)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await expect(page.getByTestId('revenue-details-panel')).toBeVisible()
  await page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(page.getByTestId('revenue-details-panel')).toHaveCount(0)
  await page.mouse.up()

  // 3. 输入框聚焦时按 Shift+H 不触发防窥切换
  const searchInput = page.getByTestId('workbench-search-input')
  await searchInput.focus()
  await page.keyboard.press('Shift+H')
  await expect(page.getByTestId('revenue-details-panel')).toHaveCount(0)

  // 4. 失焦后按 Shift+H 解锁明文，30 秒无操作自动恢复防窥
  await searchInput.evaluate((el) => el.blur())
  await page.keyboard.press('Shift+H')
  await expect(page.getByTestId('revenue-details-panel')).toBeVisible()
  await expect(page.getByTestId('home-store-section')).toContainText('¥12,800.00')
  await expect(page.getByTestId('home-activity-section')).toContainText('1195.59 元')

  await page.clock.fastForward(30_100)
  await expect(page.getByTestId('revenue-details-panel')).toHaveCount(0)
  await expect(page.getByTestId('home-store-section')).not.toContainText('¥12,800.00')

  // 5. 顶部眼睛按钮一键切换
  await page.getByTestId('privacy-toggle-mobile').click()
  await expect(page.getByTestId('revenue-details-panel')).toBeVisible()
  await page.getByTestId('privacy-toggle-mobile').click()
  await expect(page.getByTestId('revenue-details-panel')).toHaveCount(0)
})

test('闭店过滤与小程序管理台整页跳转验证（融合现网 7f5b435 能力）', async ({ page }) => {
  await page.route('**/mini-program', async (route) => {
    return route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><body><h1>BUDU Mini Program Console</h1></body></html>',
    })
  })
  await page.setViewportSize({ width: 390, height: 844 })
  // 2026-11-20 在朝外闭店日（2026-10-13）之后，在营门店仅剩 3 家（通盈、官舍、西单）
  await page.goto('/tests/home-workspace-harness.html?month=2026-11&day=11-20')

  const statusCard = page.getByTestId('operations-status-card')
  // 分母剔除朝外闭店门店（2/3 已录入），目标达成率按 3 店总目标 6000 元计算（(1800+1200)/6000 = 50%）
  await expect(statusCard).toContainText('2/3 已录入')
  await expect(statusCard).toContainText('50%')
  await expect(page.getByTestId('home-store-section')).not.toContainText('北京朝外店')
  await expect(page.getByTestId('home-store-section')).toContainText('北京通盈中心店')
  await expect(page.getByTestId('home-store-section')).toContainText('北京官舍店')
  await expect(page.getByTestId('home-store-section')).toContainText('北京西单店')

  // 打开「门店经营」子菜单，验证「小程序管理台」为整页跳转 /mini-program 而非站内 Tab 切换
  await page.getByTestId('workbench-item-store').click()
  const storeSheet = page.getByRole('dialog', { name: '门店经营' })
  await expect(storeSheet).toBeVisible()
  const mpLink = storeSheet.getByTestId('submenu-link-online-catalog')
  await expect(mpLink).toBeVisible()
  await expect(mpLink).toContainText('小程序管理台')
  await expect(mpLink).toHaveAttribute('href', '/mini-program')
  await mpLink.click()
  await expect(page).toHaveURL(/\/mini-program$/)
  await expect(page.getByText('BUDU Mini Program Console')).toBeVisible()
})

test('功能工作台支持分组/宫格切换、关键词过滤、子菜单面板与敏感入口二次确认', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/tests/home-workspace-harness.html')

  const workbench = page.getByTestId('home-workbench')
  await expect(workbench).toContainText('日常运营')
  await expect(workbench).toContainText('业务与卡券')
  await expect(workbench).toContainText('数据与系统')

  // 切换为全部紧凑宫格
  await page.getByTestId('workbench-mode-grid').click()
  await expect(page.getByTestId('workbench-compact-grid')).toBeVisible()
  await page.getByTestId('workbench-mode-grouped').click()

  // 子菜单项点击弹出 Bottom Sheet
  await page.getByTestId('workbench-item-staff').click()
  const staffSheet = page.getByRole('dialog', { name: '人员管理' })
  await expect(staffSheet).toBeVisible()
  await expect(staffSheet).toContainText('工资条')
  await staffSheet.getByRole('button', { name: '工资条' }).click()
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.navigation)).toBe('staff-payroll')

  // 敏感入口防窥态带小锁标并需二次确认
  await expect(page.getByTestId('sensitive-lock-analysis')).toBeVisible()
  await expect(page.getByTestId('sensitive-lock-finance')).toBeVisible()
  await page.getByTestId('workbench-item-finance').click()
  const confirmDialog = page.getByRole('dialog', { name: '防窥访问确认' })
  await expect(confirmDialog).toBeVisible()
  await confirmDialog.getByRole('button', { name: '取消' }).click()
  await expect(confirmDialog).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.navigation)).toBe('staff-payroll')

  await page.getByTestId('workbench-item-analysis').click()
  await page.getByTestId('confirm-sensitive-navigate').click()
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.navigation)).toBe('analysis')

  // 关键词搜索子菜单直达 + 底部「更多」仍可打开侧边栏
  await page.getByTestId('workbench-search-input').fill('排班')
  await workbench.getByRole('button', { name: /门店排班/ }).click()
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.navigation)).toBe('store-schedule')

  await page.getByRole('button', { name: '打开全部功能' }).click()
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.sidebar)).toBe('open')
})

test('待办数量、缺失门店面板和审批跳转正常', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/tests/home-workspace-harness.html')
  await expect(page.getByRole('button', { name: /待审批/ })).toContainText('2')
  await expect(page.getByRole('button', { name: /库存预警/ })).toContainText('1')
  await page.getByRole('button', { name: /门店待录入/ }).click()
  await expect(page.getByRole('dialog', { name: '待录入门店' })).toBeVisible()
  await page.getByRole('button', { name: '关闭' }).last().click()
  await page.getByRole('button', { name: /待审批/ }).click()
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.navigation)).toBe('approval')
})

test('公开账号与 store 受限账号强制保持防窥，眼睛按钮、Shift+H 与按住偷看均无法解锁真实金额', async ({ page }) => {
  const protectedRequests = []
  page.on('request', (request) => {
    if (/approvals\/requests|notifications|stock\/alerts/.test(request.url())) protectedRequests.push(request.url())
  })
  await page.setViewportSize({ width: 390, height: 844 })

  // 1. public 角色
  await page.goto('/tests/home-workspace-harness.html?role=public')
  await expect(page.getByText('•••').first()).toBeVisible()
  await expect(page.getByText('当前账号无管理待办')).toBeVisible()
  await expect(page.getByTestId('privacy-toggle-mobile')).toBeDisabled()
  await expect(page.getByTestId('peek-revenue-btn')).toHaveCount(0)
  await page.keyboard.press('Shift+H')
  await expect(page.getByTestId('revenue-details-panel')).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText('¥24,900.00')
  await expect(page.locator('body')).not.toContainText('¥12,800.00')
  await page.waitForTimeout(200)
  expect(protectedRequests).toEqual([])

  // 2. store 受限角色
  await page.goto('/tests/home-workspace-harness.html?role=store')
  await expect(page.getByTestId('privacy-toggle-mobile')).toBeDisabled()
  await expect(page.getByTestId('peek-revenue-btn')).toHaveCount(0)
  await page.keyboard.press('Shift+H')
  await expect(page.getByTestId('revenue-details-panel')).toHaveCount(0)
  await expect(page.getByTestId('home-store-section')).toContainText('门店运营模式 · 经营数据已隐藏')
  await expect(page.locator('body')).not.toContainText('¥24,900.00')
  await expect(page.locator('body')).not.toContainText('¥12,800.00')
})
