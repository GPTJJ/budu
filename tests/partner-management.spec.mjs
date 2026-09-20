import { expect, test } from '@playwright/test'

async function openQhd(page) {
  await page.goto('/tests/partner-management-harness.html')
  await page.getByRole('button', { name: /秦皇岛合作商/ }).click()
  await expect(page.getByRole('heading', { name: '秦皇岛合作商' })).toBeVisible()
}

test('开发者管理台展示 Partner 唯一档案、门店、账号与审计，不提供删除', async ({ page }) => {
  await openQhd(page)
  await expect(page.getByText('65.00%')).toBeVisible()
  await expect(page.getByText('秦皇岛一店')).toBeVisible()
  await expect(page.getByText('qhd-partner')).toBeVisible()
  await expect(page.getByText('PARTNER_CREATED')).toBeVisible()
  await expect(page.getByRole('button', { name: /删除/ })).toHaveCount(0)
})

test('受控开通一次提交 Partner、首家门店与首个 User 账号', async ({ page }) => {
  await page.goto('/tests/partner-management-harness.html')
  await page.getByRole('button', { name: '创建合作商' }).click()
  const dialog = page.getByRole('dialog', { name: '创建合作商' })
  await dialog.getByText('合作商名称').locator('input').fill('天津合作商')
  await dialog.getByText('公司主体').locator('input').fill('天津布都商贸有限公司')
  await dialog.getByText('联系人', { exact: true }).first().locator('input').fill('张先生')
  await dialog.getByText('联系电话', { exact: true }).first().locator('input').fill('13700000000')
  await dialog.getByText('门店名称').locator('input').fill('天津一店')
  await dialog.getByText('联系人', { exact: true }).nth(1).locator('input').fill('赵女士')
  await dialog.getByText('联系电话', { exact: true }).nth(1).locator('input').fill('13600000000')
  await dialog.getByText('省 / 直辖市').locator('input').fill('天津市')
  await dialog.getByText('城市').locator('input').fill('天津市')
  await dialog.getByText('区 / 县').locator('input').fill('和平区')
  await dialog.getByText('详细收货地址').locator('input').fill('南京路1号')
  await dialog.getByText('用户名').locator('input').fill('tianjin-partner')
  await dialog.getByText('初始密码').locator('input').fill('Secret-123')
  await dialog.getByRole('button', { name: '原子创建 Partner、门店与账号' }).click()
  await expect.poll(() => page.evaluate(() => window.__partnerManagementTest.requests.find(row => row.type === 'partner-create')?.body)).toMatchObject({ name: '天津合作商', defaultDiscountBps: 6500, store: { name: '天津一店', status: 'ACTIVE' }, account: { username: 'tianjin-partner', password: 'Secret-123' } })
})

test('折扣、合作商生命周期与门店状态都通过受控接口维护', async ({ page }) => {
  await openQhd(page)
  await page.getByRole('button', { name: '编辑档案' }).click()
  const profile = page.getByRole('dialog', { name: '编辑合作商档案' })
  await profile.getByText('进货折扣（%）').locator('input').fill('70')
  await profile.getByRole('button', { name: '保存档案' }).click()
  await expect.poll(() => page.evaluate(() => window.__partnerManagementTest.requests.find(row => row.type === 'partner-update')?.body.defaultDiscountBps)).toBe(7000)
  await page.getByText('秦皇岛一店').click()
  const store = page.getByRole('dialog', { name: '编辑合作门店' })
  await store.getByText('状态').locator('select').selectOption('INACTIVE')
  await store.getByRole('button', { name: '保存合作门店' }).click()
  await expect.poll(() => page.evaluate(() => window.__partnerManagementTest.requests.find(row => row.type === 'store-update')?.body.status)).toBe('INACTIVE')
  await page.getByRole('button', { name: '暂停补货' }).click()
  await expect.poll(() => page.evaluate(() => window.__partnerManagementTest.requests.find(row => row.type === 'partner-status')?.body.status)).toBe('PAUSED')
})

for (const width of [320, 340, 375, 390, 430]) {
  test(`${width}px 档案与受控开通弹层无横向穿模`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/tests/partner-management-harness.html')
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
    await page.getByRole('button', { name: '创建合作商' }).click()
    await expect(page.getByRole('dialog', { name: '创建合作商' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
    const panel = await page.getByRole('dialog').evaluate(el => ({ top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom, viewport: innerHeight }))
    expect(panel.top).toBeGreaterThanOrEqual(0)
    expect(panel.bottom).toBeLessThanOrEqual(panel.viewport + 1)
  })
}
