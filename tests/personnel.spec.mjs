import { expect, test } from '@playwright/test'
import * as XLSX from 'xlsx'

test.beforeEach(async ({ page }) => {
  await page.route('**/api/v2/daily-store-staff?month=*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ rows: [{
        id: 'dss-ye-20260809', employeeId: 'emp-ye', employeeName: '叶芷辰',
        storeKey: 'tongying', date: '2026-08-09', actualHours: 12,
      }] }),
    })
  })
})

test('人员管理顶部工具栏在移动端、iPad 与桌面保持紧凑且无溢出', async ({ page }) => {
  await page.goto('/tests/personnel-harness.html')

  for (const width of [320, 340, 375, 390, 430, 768, 1440]) {
    await page.setViewportSize({ width, height: width < 600 ? 844 : 1024 })
    const toolbar = page.getByTestId('personnel-toolbar')
    await expect(toolbar).toBeVisible()
    await expect(page.getByTestId('personnel-counts')).toHaveText('全职 3 人 · 兼职 7 人')

    const metrics = await page.evaluate(() => {
      const rect = (element) => element.getBoundingClientRect()
      const month = document.querySelector('[data-testid="personnel-month-selector"] button')
      const filters = [...document.querySelectorAll('[data-testid="personnel-filters"] > button')]
      const actions = [...document.querySelectorAll('[data-testid="personnel-actions"] > button')]
      const controls = [month, ...filters, ...actions].filter(Boolean)
      const overlaps = (left, right) => {
        const a = rect(left)
        const b = rect(right)
        return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
      }
      return {
        viewportWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        monthText: month?.innerText.trim(),
        monthClipped: month ? month.scrollWidth > month.clientWidth : true,
        filterClipped: filters.some((element) => element.scrollWidth > element.clientWidth),
        actionClipped: actions.some((element) => element.scrollWidth > element.clientWidth),
        actionWhiteSpace: actions.map((element) => getComputedStyle(element).whiteSpace),
        actionWidths: actions.map((element) => rect(element).width),
        actionHeights: actions.map((element) => rect(element).height),
        overlapCount: controls.flatMap((element, index) => (
          controls.slice(index + 1).map((other) => overlaps(element, other))
        )).filter(Boolean).length,
      }
    })

    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.viewportWidth)
    expect(metrics.monthText).toContain('2026年08月')
    expect(metrics.monthClipped).toBe(false)
    expect(metrics.filterClipped).toBe(false)
    expect(metrics.actionClipped).toBe(false)
    expect(metrics.actionWhiteSpace).toEqual(['nowrap', 'nowrap'])
    expect(metrics.overlapCount).toBe(0)
    expect(metrics.actionHeights.every((height) => height >= 44 && height <= 48)).toBe(true)
    if (width < 768) {
      expect(Math.abs(metrics.actionWidths[0] - metrics.actionWidths[1])).toBeLessThanOrEqual(1)
    }
  }
})

test('人员筛选、月份选择、添加与导出入口行为保持不变', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 844 })
  await page.goto('/tests/personnel-harness.html')

  await page.getByRole('button', { name: '全职人员（3）' }).click()
  await expect(page.getByText('隋晓', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('陈文慧', { exact: true }).first()).toBeHidden()
  await page.getByRole('button', { name: '兼职人员（7）' }).click()
  await expect(page.getByText('陈文慧', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('隋晓', { exact: true }).first()).toBeHidden()
  await page.getByRole('button', { name: '全部（10）' }).click()

  await page.getByRole('button', { name: /2026年08月/ }).first().click()
  const calendar = page.locator('input[type="date"]').locator('../..')
  await calendar.getByRole('button').first().click()
  await expect(calendar.getByText('2026年07月', { exact: true })).toBeVisible()
  await page.locator('div.fixed.inset-0.z-30').click({ position: { x: 1, y: 1 } })
  await expect(page.getByRole('button', { name: /2026年08月/ }).first()).toBeVisible()
  await expect(page.getByTestId('personnel-counts')).toHaveText('全职 3 人 · 兼职 7 人')

  await page.getByRole('button', { name: '添加员工', exact: true }).click()
  await expect(page.getByRole('heading', { name: '添加员工' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('heading', { name: '添加员工' })).toBeHidden()

  await page.getByRole('button', { name: '导出表格', exact: true }).click()
  await expect(page.getByRole('heading', { name: '导出表格' })).toBeVisible()
  await page.getByRole('button', { name: '关闭' }).click()
  await expect(page.getByRole('heading', { name: '导出表格' })).toBeHidden()
})

test('雇员页面恢复既有全职与兼职主档', async ({ page }) => {
  await page.goto('/tests/personnel-harness.html')
  await expect(page.getByRole('button', { name: '全部（10）' })).toBeVisible()
  await expect(page.getByRole('button', { name: '全职人员（3）' })).toBeVisible()
  await expect(page.getByRole('button', { name: '兼职人员（7）' })).toBeVisible()
  for (const name of ['隋晓', '叶芷辰', '李飞燕', '左可翠', '陈文慧', '舒敏', '史璐璐', '马婧欣', '龚艺锦', '王红云']) {
    await expect(page.getByText(name, { exact: true }).first()).toBeVisible()
  }
})

test('员工卡片工资明细下载为可读取的 Excel 表格', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/tests/personnel-harness.html')
  const employeeCard = page.locator('.card').filter({ hasText: '叶芷辰' }).first()
  await expect(employeeCard).toBeVisible()
  await expect(employeeCard.getByText('工资调整')).toBeVisible()
  await expect(employeeCard.getByRole('button', { name: '调整每日薪资' })).toBeVisible()
  await employeeCard.click()

  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText(/叶芷辰 · 当月每日工资明细/)).toBeVisible()
  await dialog.getByRole('button', { name: '查看详情' }).click()
  await expect(dialog.getByText('临时加班补偿')).toBeVisible()
  await expect(dialog.getByRole('button', { name: '导出 Excel', exact: true })).toBeVisible()

  const downloadPromise = page.waitForEvent('download')
  await dialog.getByRole('button', { name: '导出 Excel', exact: true }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/^工资明细-叶芷辰-202608\.xlsx$/)

  const stream = await download.createReadStream()
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  const workbook = XLSX.read(Buffer.concat(chunks), { type: 'buffer' })
  expect(workbook.SheetNames).toEqual(['工资明细'])
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets['工资明细'], { header: 1, raw: true })
  expect(rows[0][0]).toBe('BUDU 员工工资明细')
  expect(rows[1][1]).toBe('叶芷辰')
  expect(rows[4]).toEqual(['日期', '值班门店', '营业额(元)', '订单', '工时(h)', '基础工资(元)', '业绩提成(元)', '调货补贴(元)', '大单奖(元)', '自动工资(元)', '薪资调整(元)', '调整原因', '最终工资(元)'])
  expect(rows.some((row) => row[0] === '2026-08-09' && row[1] === '北京通盈中心店' && row[9] === 540 && row[10] === 20 && row[11] === '临时加班补偿' && row[12] === 560)).toBe(true)
})

test('开发者可调整每日最终工资并提交审计明细', async ({ page }) => {
  let submitted = null
  await page.route('**/api/v2/daily-pay-adjustments', async (route) => {
    submitted = route.request().postDataJSON()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        adjustment: {
          id: 'dpa-test',
          employeeId: 'emp-ye',
          staffName: '叶芷辰',
          date: '2026-08-09',
          autoPayCentsSnapshot: '54000',
          adjustedPayCents: '57000',
          reason: '闭店加班补偿',
          createdBy: 'developer',
          updatedBy: 'developer',
          createdAt: '2026-08-10T01:00:00.000Z',
          updatedAt: '2026-08-13T15:00:00.000Z',
          version: 2,
        },
      }),
    })
  })

  await page.goto('/tests/personnel-harness.html')
  const employeeCard = page.locator('.card').filter({ hasText: '叶芷辰' }).first()
  await employeeCard.getByRole('button', { name: '调整每日薪资' }).click()
  const dialog = page.getByRole('dialog', { name: '调整每日薪资' })
  await expect(dialog).toBeVisible()
  await dialog.locator('input[type="date"]').fill('2026-08-09')
  await expect(dialog.getByText('当前人工调整明细')).toBeVisible()
  await dialog.locator('input[type="number"]').fill('570')
  await dialog.locator('textarea').fill('闭店加班补偿')
  await dialog.getByRole('button', { name: '更新调整' }).click()

  await expect(dialog.getByText('当日工资已调整并生效')).toBeVisible()
  expect(submitted).toEqual({
    employeeId: 'emp-ye',
    staffName: '叶芷辰',
    date: '2026-08-09',
    autoPayCentsSnapshot: 54000,
    adjustedPayCents: 57000,
    reason: '闭店加班补偿',
    version: 1,
  })
})

test('Developer 无值班记录也可直接设定当日最终工资', async ({ page }) => {
  let submitted = null
  await page.route('**/api/v2/daily-pay-adjustments', async (route) => {
    if (route.request().method() !== 'PUT') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rows: [] }) })
      return
    }
    submitted = route.request().postDataJSON()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        adjustment: {
          id: 'dpa-no-duty', employeeId: 'emp-chen', staffName: '陈文慧', date: '2026-08-24', autoPayCentsSnapshot: '0',
          adjustedPayCents: '12345', reason: '无排班临时补贴', createdBy: 'developer', updatedBy: 'developer',
          createdAt: '2026-08-24T06:00:00.000Z', updatedAt: '2026-08-24T06:00:00.000Z', version: 1,
        },
      }),
    })
  })

  await page.goto('/tests/personnel-harness.html')
  const employeeCard = page.locator('.card').filter({ hasText: '陈文慧' }).first()
  await employeeCard.getByRole('button', { name: '调整每日薪资' }).click()
  const dialog = page.getByRole('dialog', { name: '调整每日薪资' })
  await dialog.locator('input[type="date"]').fill('2026-08-24')
  await expect(dialog.getByText(/Developer 可直接设定最终工资/)).toBeVisible()
  await expect(dialog.getByRole('button', { name: '确认调整' })).toBeEnabled()
  await dialog.locator('input[type="number"]').fill('123.45')
  await dialog.locator('textarea').fill('无排班临时补贴')
  await dialog.getByRole('button', { name: '确认调整' }).click()
  await expect(dialog.getByText('当日工资已调整并生效')).toBeVisible()
  expect(submitted).toEqual({
    employeeId: 'emp-chen',
    staffName: '陈文慧',
    date: '2026-08-24',
    autoPayCentsSnapshot: 0,
    adjustedPayCents: 12345,
    reason: '无排班临时补贴',
  })
})
