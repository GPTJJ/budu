// 排班页优化 E2E：默认全门店视图、绑定员工高亮、员工只读
import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/schedule-harness.html?mode=developer')
  await expect(page.locator('body')).toContainText('门店排班')
})

test('默认显示所有门店排班详情（全部门店视图）', async ({ page }) => {
  // 两个门店的周排班表都应渲染（每个门店一个卡片）
  await expect(page.getByText('北京通盈中心店').first()).toBeVisible()
  await expect(page.getByText('北京官舍店').first()).toBeVisible()
  // 两个门店的班次都可见
  await expect(page.getByText('叶芷辰', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('龚艺锦', { exact: true }).first()).toBeVisible()
  // 「全部门店」tab 默认选中
  await expect(page.getByRole('button', { name: '全部门店' })).toBeVisible()
})

test('单店视图可切换', async ({ page }) => {
  await page.getByRole('button', { name: '北京通盈中心店' }).first().click()
  // 单店视图只显示一个周排班表
  await expect(page.getByText('北京通盈中心店').first()).toBeVisible()
  // 通盈中心店有排班：叶芷辰可见
  await expect(page.getByText('叶芷辰', { exact: true }).first()).toBeVisible()
})

test('绑定员工查看时当班名字高亮（含「我」徽标）', async ({ page }) => {
  await page.goto('/tests/schedule-harness.html?mode=staff')
  await expect(page.locator('body')).toContainText('门店排班')
  // 叶芷辰（tongying 店）排班项高亮：amber 背景 + 「我」徽标
  const myBadge = page.getByText('我', { exact: true })
  await expect(myBadge.first()).toBeVisible()
  // 叶芷辰有两个班次（周二早班/周四通班）各带「我」徽标；非本人（龚艺锦）无徽标
  await expect(page.getByText('我', { exact: true })).toHaveCount(2)
  const gongCard = page.locator('div.rounded-xl.p-2.shadow-sm').filter({ hasText: '龚艺锦' })
  await expect(gongCard.getByText('我', { exact: true })).toHaveCount(0)
})

test('员工只有查看权限：无添加/删除按钮，只读模式提示', async ({ page }) => {
  await page.goto('/tests/schedule-harness.html?mode=staff')
  await expect(page.locator('body')).toContainText('门店排班')
  await expect(page.getByText('只读模式').first()).toBeVisible()
  await expect(page.getByRole('button', { name: '添加排班' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '删除' })).toHaveCount(0)
})

test('开发者可添加排班（全部门店视图下弹窗显示对应门店）', async ({ page }) => {
  await page.getByRole('button', { name: '添加排班' }).first().click()
  await expect(page.getByText('添加员工排班')).toBeVisible()
  // 弹窗副标题含对应门店名（第一个添加按钮属于第一家门店 tongying）
  await expect(page.getByText(/添加员工排班/)).toBeVisible()
  await expect(page.getByText(/· 北京通盈中心店 ·/)).toBeVisible()
})

test('新增排班只写本地 draft，最终一次保存且以 Employee.id 为身份键', async ({ page }) => {
  await page.getByRole('button', { name: '添加排班' }).first().click()
  await page.getByRole('combobox').first().selectOption('emp-gong')
  await page.getByRole('button', { name: '确认添加' }).click()
  expect(await page.evaluate(() => window.schedulePutCount)).toBe(0)
  await expect(page.getByTestId('schedule-dirty')).toBeVisible()
  await page.getByTestId('schedule-save-mobile').click()
  await expect.poll(() => page.evaluate(() => window.schedulePutCount)).toBe(1)
  const body = await page.evaluate(() => window.lastSchedulePutBody)
  const shifts = body.stores.flatMap((store) => Object.values(store.days).flat())
  expect(shifts.some((row) => row.employeeId === 'emp-gong' && row.staff === '龚艺锦')).toBe(true)
  await expect(page.getByRole('dialog', { name: '排班已保存' })).toHaveCount(1)
  await page.reload()
  await expect(page.getByText('龚艺锦', { exact: true })).toHaveCount(2)
  expect(await page.evaluate(() => window.schedulePutCount)).toBe(0)
})

test('连续添加三个班次时不发请求、不播放成功动画', async ({ page }) => {
  const additions = [
    { buttonIndex: 0, employeeId: 'emp-gong' },
    { buttonIndex: 1, employeeId: 'emp-gong' },
    { buttonIndex: 2, employeeId: 'emp-ye' },
  ]
  for (const addition of additions) {
    await page.getByRole('button', { name: '添加排班' }).nth(addition.buttonIndex).click()
    await page.getByRole('combobox').first().selectOption(addition.employeeId)
    await page.getByRole('button', { name: '确认添加' }).click()
  }
  expect(await page.evaluate(() => window.schedulePutCount)).toBe(0)
  await expect(page.getByRole('dialog', { name: '排班已保存' })).toHaveCount(0)
  await expect(page.getByTestId('schedule-dirty')).toBeVisible()
})

test('删除班次只修改 draft，不自动写服务器', async ({ page }) => {
  await page.getByRole('button', { name: '删除' }).first().click()
  expect(await page.evaluate(() => window.schedulePutCount)).toBe(0)
  await expect(page.getByTestId('schedule-dirty')).toBeVisible()
  await expect(page.getByRole('dialog', { name: '排班已保存' })).toHaveCount(0)
})

test('添加、编辑、删除可混合进行，过程中零请求且最终只发送一个批量请求', async ({ page }) => {
  await page.getByRole('button', { name: '编辑' }).first().click()
  await page.getByRole('combobox').nth(1).selectOption('晚班')
  await page.getByRole('button', { name: '确认修改' }).click()
  await page.getByRole('button', { name: '删除' }).nth(1).click()
  await page.getByRole('button', { name: '添加排班' }).nth(7).click()
  await page.getByRole('combobox').first().selectOption('emp-sui')
  await page.getByRole('button', { name: '确认添加' }).click()
  expect(await page.evaluate(() => window.schedulePutCount)).toBe(0)
  await expect(page.getByRole('dialog', { name: '排班已保存' })).toHaveCount(0)

  await page.getByTestId('schedule-save-mobile').click()
  await expect.poll(() => page.evaluate(() => window.schedulePutCount)).toBe(1)
  const body = await page.evaluate(() => window.lastSchedulePutBody)
  expect(body.stores).toHaveLength(2)
  expect(body.stores.every((store) => store.version)).toBe(true)
  await expect(page.getByTestId('schedule-dirty')).toHaveCount(0)
})

test('保存失败保留全部 draft 且不播放成功动画', async ({ page }) => {
  await page.goto('/tests/schedule-harness.html?mode=developer&failSave=1')
  await page.getByRole('button', { name: '添加排班' }).first().click()
  await page.getByRole('combobox').first().selectOption('emp-gong')
  await page.getByRole('button', { name: '确认添加' }).click()
  await page.getByTestId('schedule-save-mobile').click()
  await expect(page.getByRole('alert')).toContainText('测试保存失败')
  await expect(page.getByText('龚艺锦', { exact: true }).first()).toBeVisible()
  await expect(page.getByTestId('schedule-dirty')).toBeVisible()
  await expect(page.getByRole('dialog', { name: '排班已保存' })).toHaveCount(0)
})

test('未保存修改统一拦截返回、周切换、门店切换与外部导航', async ({ page }) => {
  await page.getByRole('button', { name: '添加排班' }).first().click()
  await page.getByRole('combobox').first().selectOption('emp-gong')
  await page.getByRole('button', { name: '确认添加' }).click()

  await page.getByRole('button', { name: '返回首页' }).click()
  await expect(page.getByTestId('schedule-unsaved-dialog')).toBeVisible()
  await page.getByRole('button', { name: '继续编辑' }).click()
  expect(await page.evaluate(() => window.backCount)).toBe(0)

  await page.getByRole('button', { name: '下一周' }).click()
  await expect(page.getByTestId('schedule-unsaved-dialog')).toBeVisible()
  await page.getByRole('button', { name: '继续编辑' }).click()

  await page.getByRole('button', { name: '北京通盈中心店' }).first().click()
  await expect(page.getByTestId('schedule-unsaved-dialog')).toBeVisible()
  await page.getByRole('button', { name: '继续编辑' }).click()

  await page.evaluate(() => window.triggerExternalNavigation())
  await expect(page.getByTestId('schedule-unsaved-dialog')).toBeVisible()
  await page.getByRole('button', { name: '放弃修改' }).click()
  expect(await page.evaluate(() => window.externalNavigationCount)).toBe(1)
  expect(await page.evaluate(() => window.schedulePutCount)).toBe(0)
  await expect(page.getByTestId('schedule-dirty')).toHaveCount(0)
})

test('经理保持可编辑权限', async ({ page }) => {
  await page.goto('/tests/schedule-harness.html?mode=manager')
  await expect(page.locator('body')).toContainText('门店排班')
  await expect(page.getByRole('button', { name: '添加排班' }).first()).toBeVisible()
  await expect(page.getByText('只读模式')).toHaveCount(0)
})

for (const width of [320, 340, 375, 390, 430]) {
  test(`移动端 ${width}px 保存区不导致页面横向 overflow`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await page.getByRole('button', { name: '添加排班' }).first().click()
    await page.getByRole('combobox').first().selectOption('emp-gong')
    await page.getByRole('button', { name: '确认添加' }).click()
    await expect(page.getByTestId('schedule-save-mobile')).toBeVisible()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
    expect(overflow).toBe(false)
    const button = await page.getByTestId('schedule-save-mobile').boundingBox()
    expect(button.x).toBeGreaterThanOrEqual(0)
    expect(button.x + button.width).toBeLessThanOrEqual(width)
  })
}

test.describe('导出排班图片', () => {
  test.use({
    hasTouch: false,
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    viewport: { width: 1280, height: 900 },
  })

  test('桌面端点击「导出图片」下载整周排班 PNG（含门店名，不含增删按钮）', async ({ page }) => {
    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: '导出图片' }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toMatch(/排班表-\d{4}-\d{2}-\d{2}~\d{4}-\d{2}-\d{2}-全部门店\.png$/)
    const fs = await import('node:fs')
    const buf = fs.readFileSync(await download.path())
    // PNG 魔数 + 非空图片
    expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(buf.length).toBeGreaterThan(5000)
  })

  test('单店视图导出文件名含门店名', async ({ page }) => {
    await page.getByRole('button', { name: '北京通盈中心店' }).first().click()
    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: '导出图片' }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toMatch(/排班表-.*-北京通盈中心店\.png$/)
  })
})
