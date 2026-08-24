import { expect, test } from '@playwright/test'

test('系统设置保留全部业务配置并移除语言入口', async ({ page }) => {
  let salesSourcePayload = null
  let secondPasswordPayload = null
  const authorityStores = [
    { key: 'tongying', name: '北京通盈中心店', district: '朝阳区 · 三里屯' },
    { key: 'guanshe', name: '北京官舍店', district: '朝阳区 · 亮马桥' },
    { key: 'chaowai', name: '北京朝外店', district: '朝阳区 · 朝外' },
    { key: 'xidan', name: '北京西单店', district: '西城区 · 西单' },
  ]

  await page.route('**/api/v2/stores', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ rows: authorityStores }) })
  })

  await page.route('**/api/v2/wechat/bindings', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ configured: false, rows: [] }),
  }))
  await page.route('**/api/v2/store-sales-sources', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ rows: [{ storeKey: 'guanshe', storeName: '官舍店', salesDataSource: 'manual', salesDataSourceEffectiveDate: '2026-08-01' }] }),
  }))
  await page.route('**/api/v2/alerts/test', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ configured: true }),
  }))
  await page.route('**/api/auth/second-password', async (route) => {
    secondPasswordPayload = route.request().postDataJSON()
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) })
  })
  await page.route('**/api/v2/store-sales-source', async (route) => {
    salesSourcePayload = route.request().postDataJSON()
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) })
  })
  await page.route('**/api/userdata', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ ok: true }),
  }))

  await page.goto('/tests/settings-harness.html')
  await expect(page.getByRole('heading', { name: '系统设置' })).toBeVisible()
  await expect(page.getByText('企业微信告警')).toBeVisible()
  await expect(page.getByText('微信提醒', { exact: true })).toBeVisible()
  await expect(page.getByText('二级密码', { exact: true })).toBeVisible()
  await expect(page.getByText('门店管理', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '新增门店' })).toHaveCount(0)
  await expect(page.getByText('POS 试点门店配置')).toBeVisible()
  await expect(page.getByText('PostgreSQL / 云端共享数据 / POS 实时汇总')).toBeVisible()
  await expect(page.getByText('界面语言')).toHaveCount(0)
  await expect(page.getByText('English', { exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: '发送测试消息' }).click()
  await expect(page.getByText('测试消息已发送 ✓')).toBeVisible()

  await page.getByLabel('当前登录密码').fill('login-password')
  await page.getByLabel('新二级密码（至少 6 位）').fill('second-password')
  await page.getByLabel('确认新二级密码').fill('second-password')
  await page.getByRole('button', { name: '保存二级密码' }).click()
  await expect(page.getByText('二级密码已保存')).toBeVisible()
  expect(secondPasswordPayload).toEqual({ oldPassword: 'login-password', newSecondPassword: 'second-password' })

  await page.getByLabel('销售数据来源').selectOption('pos')
  await page.getByRole('button', { name: '保存配置' }).click()
  await expect(page.getByText('门店销售数据来源已保存 ✓')).toBeVisible()
  expect(salesSourcePayload).toMatchObject({ storeKey: 'guanshe', salesDataSource: 'pos', effectiveDate: '2026-08-01' })

  await page.getByRole('button', { name: '返回首页' }).click()
  await expect.poll(() => page.locator('html').getAttribute('data-back')).toBe('true')
})
