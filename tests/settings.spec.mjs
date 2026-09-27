import { expect, test } from '@playwright/test'

const authorityStores = [
  { storeKey: 'tongying', storeName: '北京通盈中心店', salesDataSource: 'pos', salesDataSourceEffectiveDate: '2026-08-11' },
  { storeKey: 'guanshe', storeName: '北京官舍店', salesDataSource: 'manual', salesDataSourceEffectiveDate: '2026-08-01' },
  { storeKey: 'chaowai', storeName: '北京朝外店', salesDataSource: 'manual', salesDataSourceEffectiveDate: '2026-08-01' },
  { storeKey: 'xidan', storeName: '北京西单店', salesDataSource: 'manual', salesDataSourceEffectiveDate: '2026-08-01' },
]

async function mockSettings(page, { configured = true, bound = true } = {}) {
  let salesSourcePayload = null
  let secondPasswordPayload = null
  await page.route('**/api/health', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, dbOk: true, env: 'prod', gitSha: 'settings-test-sha' }) }))
  await page.route('**/api/v2/alerts/status', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, configured: true }) }))
  await page.route('**/api/v2/alerts/test', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, configured: true }) }))
  await page.route('**/api/v2/wechat/bindings', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ configured, rows: bound ? [{ id: 'wx-1', status: 'active', identityHint: 'd***u', channel: 'wecom' }] : [] }),
  }))
  await page.route('**/api/v2/store-sales-sources', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ rows: authorityStores }) }))
  await page.route('**/api/v2/developer-sensitive-records?**', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ rows: [] }) }))
  await page.route('**/api/auth/second-password', async (route) => {
    secondPasswordPayload = route.request().postDataJSON()
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) })
  })
  await page.route('**/api/v2/store-sales-source', async (route) => {
    salesSourcePayload = route.request().postDataJSON()
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) })
  })
  return {
    salesSourcePayload: () => salesSourcePayload,
    secondPasswordPayload: () => secondPasswordPayload,
  }
}

test('系统设置 2.0 使用四分组浏览架构，旧功能全部下沉可达', async ({ page }) => {
  const payloads = await mockSettings(page)
  await page.goto('/tests/settings-harness.html')

  await expect(page.getByText('提醒与通知', { exact: true })).toBeVisible()
  await expect(page.getByText('门店与 POS', { exact: true })).toBeVisible()
  await expect(page.getByText('账号与安全', { exact: true })).toBeVisible()
  await expect(page.getByText('开发者与系统', { exact: true })).toBeVisible()
  await expect(page.getByText('1 家 POS · 3 家人工')).toBeVisible()
  await expect(page.getByText('WECHAT_WORK_WEBHOOK_URL')).toHaveCount(0)
  await expect(page.getByPlaceholder('企微 userid')).toHaveCount(0)
  await expect(page.getByLabel('当前登录密码')).toHaveCount(0)

  await page.getByTestId('settings-row-alert').click()
  await expect(page.getByRole('heading', { name: '企业微信告警' })).toBeVisible()
  await expect(page.getByText('webhook 或密钥')).toBeVisible()
  await page.getByRole('button', { name: '发送测试消息' }).click()
  await expect(page.getByText('测试消息已发送 ✓')).toBeVisible()
  await page.getByRole('button', { name: '返回设置' }).click()

  await page.getByTestId('settings-row-wechat').click()
  await expect(page.getByText('d***u')).toBeVisible()
  await expect(page.getByRole('button', { name: '发送测试' })).toBeVisible()
  await page.getByRole('button', { name: '解除绑定' }).click()
  await expect(page.getByRole('dialog', { name: '解除微信绑定' })).toBeVisible()
  await expect.poll(() => page.locator('html').getAttribute('class')).toContain('budu-overlay-open')
  await page.getByRole('button', { name: '取消' }).click()
  await expect(page.getByRole('dialog', { name: '解除微信绑定' })).toHaveCount(0)
  await page.getByRole('button', { name: '返回设置' }).click()

  await page.getByTestId('settings-row-security').click()
  await page.getByLabel('当前登录密码').fill('login-password')
  await page.getByLabel('新二级密码（至少 6 位）').fill('second-password')
  await page.getByLabel('确认新二级密码').fill('second-password')
  await page.getByRole('button', { name: '保存二级密码' }).click()
  await expect(page.getByText('二级密码已保存')).toBeVisible()
  expect(payloads.secondPasswordPayload()).toEqual({ oldPassword: 'login-password', newSecondPassword: 'second-password' })
  await page.getByRole('button', { name: '返回设置' }).click()

  await page.getByTestId('settings-row-pos').click()
  await expect(page.getByText('配置只从生效日期起作用')).toBeVisible()
  await page.getByLabel('门店').selectOption('chaowai')
  await page.getByLabel('销售数据来源').selectOption('pos')
  await page.getByRole('button', { name: '保存配置' }).click()
  await expect(page.getByText('门店销售数据来源已保存 ✓')).toBeVisible()
  expect(payloads.salesSourcePayload()).toMatchObject({ storeKey: 'chaowai', salesDataSource: 'pos', effectiveDate: '2026-08-01' })
  await page.getByRole('button', { name: '返回设置' }).click()

  await page.getByTestId('settings-row-developer').click()
  await expect(page.getByLabel('开发者绑定系统账号')).toBeVisible()
  await expect(page.getByTestId('deleted-records-center')).toBeVisible()
  await expect(page.getByText('业务数据以 PostgreSQL 为权威')).toBeVisible()
  await page.getByRole('button', { name: '返回设置' }).click()

  await page.getByTestId('settings-row-system').click()
  await expect(page.getByText('PostgreSQL / 云端共享')).toBeVisible()
  await expect(page.getByText('settings-test-sha')).toBeVisible()
  await expect(page.getByText('token、webhook 与密码不会')).toBeVisible()
})

test('开发者工具与敏感配置不向普通角色展示', async ({ page }) => {
  await mockSettings(page, { configured: true, bound: false })
  await page.goto('/tests/settings-harness.html?role=manager')
  await expect(page.getByTestId('settings-row-developer')).toHaveCount(0)
  await expect(page.getByTestId('settings-row-pos')).toHaveCount(0)
  await expect(page.getByTestId('settings-row-security')).toHaveCount(0)
  await expect(page.getByTestId('settings-row-alert')).toHaveCount(0)
  await expect(page.getByTestId('settings-row-wechat')).toBeVisible()
  await expect(page.getByTestId('settings-row-system')).toBeVisible()
  await expect(page.getByText('企微 userid')).toHaveCount(0)
})

for (const width of [320, 340, 375, 390, 430]) {
  test(`${width}px grouped settings 与二级页面无横向溢出`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await mockSettings(page)
    await page.goto('/tests/settings-harness.html')
    for (const id of ['settings-row-alert', 'settings-row-wechat', 'settings-row-pos', 'settings-row-security', 'settings-row-developer', 'settings-row-system']) {
      const row = page.getByTestId(id)
      await expect(row).toBeVisible()
      expect((await row.evaluate((element) => element.getBoundingClientRect().height))).toBeGreaterThanOrEqual(44)
      await row.click()
      await expect(page.getByTestId('settings-detail-page')).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await page.getByRole('button', { name: '返回设置' }).click()
    }
    const overflow = await page.evaluate(() => [...document.querySelectorAll('body *')]
      .map((element) => ({
        tag: element.tagName,
        text: (element.textContent || '').trim().slice(0, 60),
        left: Math.round(element.getBoundingClientRect().left),
        right: Math.round(element.getBoundingClientRect().right),
        width: Math.round(element.getBoundingClientRect().width),
      }))
      .filter((item) => item.right > window.innerWidth + 1 || item.left < -1))
    expect(overflow).toEqual([])
  })
}
