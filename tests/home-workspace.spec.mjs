import { expect, test } from '@playwright/test'

const activityRows = [
  {
    id: 'notice-1',
    templateKey: 'approval_result',
    title: '报销审批已通过',
    content: '测试报销申请已通过',
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
    content: '请及时核对工资条',
    priority: 'high',
    status: 'unread',
    target: 'staff-payroll',
    refType: 'payroll',
    createdAt: '2026-08-20T09:10:00.000Z',
  },
]

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/userdata') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entries: {}, staff: [], stores: [], analysis: {} }) })
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

for (const width of [375, 390, 430]) {
  test(`${width}px 首页无横向溢出且首屏可见经营与待办`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await page.goto('/tests/home-workspace-harness.html')
    await expect(page.getByText(/[今当]日经营/)).toBeVisible()
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

test('公开账号保持经营脱敏且不请求受限待办接口', async ({ page }) => {
  const protectedRequests = []
  page.on('request', (request) => {
    if (/approvals\/requests|notifications|stock\/alerts/.test(request.url())) protectedRequests.push(request.url())
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/tests/home-workspace-harness.html?role=public')
  await expect(page.getByText('•••').first()).toBeVisible()
  await expect(page.getByText('当前账号无管理待办')).toBeVisible()
  await page.waitForTimeout(200)
  expect(protectedRequests).toEqual([])
})
