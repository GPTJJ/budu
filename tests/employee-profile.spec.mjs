// 员工档案（EmployeeProfilePage）前端冒烟测试
// 覆盖：列表加载、详情 Tab、身份/银行卡掩码、reveal 二次确认 + 审计请求、
// 角色矩阵（developer 可 reveal；finance 可 reveal 银行卡但不可身份证；manager/staff 不可）、空态
import { expect, test } from '@playwright/test'

async function openBankCard(page, { width = 375, height = 812, stress = false } = {}) {
  await page.setViewportSize({ width, height })
  await page.goto(`/tests/employee-profile-harness.html?mode=developer${stress ? '&stress=1' : ''}`)
  await page.getByText(/隋晓/).first().click()
  await page.getByRole('button', { name: '银行卡' }).click()
  await expect(page.getByTestId('bank-card')).toBeVisible()
}

async function revealBankCard(page) {
  await page.getByRole('button', { name: '查看完整号码' }).click()
  await page.getByRole('button', { name: '确认查看' }).click()
  await expect(page.getByTestId('bank-card-copy')).toBeVisible()
}

async function bankCardGeometry(page) {
  return page.evaluate(() => {
    const get = (id) => document.querySelector(`[data-testid="${id}"]`)
    const rect = (element) => {
      if (!element) return null
      const box = element.getBoundingClientRect()
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height }
    }
    const overlaps = (a, b) => Boolean(a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top)

    const card = get('bank-card')
    const number = rect(get('bank-card-number'))
    const copy = rect(get('bank-card-copy'))
    const holder = rect(get('bank-card-holder'))
    const actions = rect(get('bank-card-actions'))
    const badge = rect(get('bank-card-payroll-badge'))
    const audit = rect(get('bank-card-audit-notice'))
    const copyStyle = get('bank-card-copy') ? getComputedStyle(get('bank-card-copy')) : null
    const auditText = get('bank-card-audit-notice')?.querySelector('span:last-child')
    const auditTextRect = rect(auditText)

    return {
      viewportOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      cardOverflow: card.scrollWidth > card.clientWidth + 1,
      numberCopyOverlap: overlaps(number, copy),
      numberHolderOverlap: overlaps(number, holder),
      holderActionsOverlap: overlaps(holder, actions),
      holderBadgeOverlap: overlaps(holder, badge),
      numberBadgeOverlap: overlaps(number, badge),
      copyBadgeOverlap: overlaps(copy, badge),
      copy: copy ? { ...copy, whiteSpace: copyStyle.whiteSpace } : null,
      audit,
      auditText: auditTextRect,
    }
  })
}

function expectStableBankCardLayout(metrics, { revealed = false } = {}) {
  expect(metrics.viewportOverflow).toBe(false)
  expect(metrics.cardOverflow).toBe(false)
  expect(metrics.numberHolderOverlap).toBe(false)
  expect(metrics.holderActionsOverlap).toBe(false)
  expect(metrics.holderBadgeOverlap).toBe(false)
  expect(metrics.numberBadgeOverlap).toBe(false)
  expect(metrics.audit.width).toBeGreaterThan(120)
  expect(metrics.auditText.width).toBeGreaterThan(80)
  expect(metrics.auditText.height).toBeLessThanOrEqual(32)
  if (revealed) {
    expect(metrics.numberCopyOverlap).toBe(false)
    expect(metrics.copyBadgeOverlap).toBe(false)
    expect(metrics.copy.width).toBeGreaterThanOrEqual(56)
    expect(metrics.copy.height).toBeLessThanOrEqual(44)
    expect(metrics.copy.whiteSpace).toBe('nowrap')
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/employee-profile-harness.html?mode=developer')
})

test('列表展示员工卡片并可进入详情', async ({ page }) => {
  await expect(page.getByText('员工档案', { exact: true }).first()).toBeVisible()
  await expect(page.getByText(/BUDU-0001/)).toBeVisible()
  await expect(page.getByText(/隋晓/).first()).toBeVisible()
  await page.getByText(/隋晓/).first().click()
  await expect(page.getByRole('button', { name: '基本信息' })).toBeVisible()
  await expect(page.getByRole('button', { name: '身份信息' })).toBeVisible()
  await expect(page.getByRole('button', { name: '银行卡' })).toBeVisible()
  await expect(page.getByRole('button', { name: '履历时间线' })).toBeVisible()
  await expect(page.getByRole('button', { name: '附件' })).toBeVisible()
})

test('跳转直达详情后点返回箭头回到列表（不再自动跳回详情）', async ({ page }) => {
  // 模拟从人员管理/工资条带员工名跳转：initial=隋晓 命中唯一员工自动进详情
  await page.goto('/tests/employee-profile-harness.html?mode=developer&initial=隋晓')
  await expect(page.getByText(/档案详情/)).toBeVisible()
  // 详情页返回按钮（页面头部左上角箭头，页面第一个按钮）
  await page.locator('button').first().click()
  // 应回到列表：搜索框可见、详情标题消失
  await expect(page.getByPlaceholder('搜索姓名 / 员工编号 / 手机号')).toBeVisible()
  await expect(page.getByText(/档案详情/)).toHaveCount(0)
  // 列表仍展示员工卡片（不会再次自动跳进详情）
  await expect(page.getByText(/BUDU-0001/)).toBeVisible()
  await expect(page.getByRole('button', { name: '基本信息' })).toHaveCount(0)
})

test('身份信息默认掩码，reveal 需确认并触发审计请求', async ({ page }) => {
  await page.getByText(/隋晓/).first().click()
  await page.getByRole('button', { name: '身份信息' }).click()
  // 默认只显示掩码
  await expect(page.getByText('110101********1234', { exact: true })).toBeVisible()
  await expect(page.getByText('110101199001011234', { exact: true })).toHaveCount(0)
  // 点击查看完整号码 → 二次确认弹窗
  await page.getByRole('button', { name: '查看完整号码' }).click()
  await expect(page.getByText('查看完整身份证号码')).toBeVisible()
  await expect(page.getByText(/记录一条审计日志/)).toBeVisible()
  await page.getByRole('button', { name: '确认查看' }).click()
  // 完整号码展示（内存中）
  await expect(page.getByText('110101199001011234', { exact: true })).toBeVisible()
  // reveal 请求已发出（即审计已在后端记录）
  const calls = await page.evaluate(() => window.__revealCalls)
  expect(calls).toContain('identity.reveal')
  // 可隐藏
  await page.getByRole('button', { name: '隐藏' }).click()
  await expect(page.getByText('110101199001011234', { exact: true })).toHaveCount(0)
})

test('银行卡掩码 + reveal 确认', async ({ page }) => {
  await page.getByText(/隋晓/).first().click()
  await page.getByRole('button', { name: '银行卡' }).click()
  await expect(page.getByText('**** **** **** 3445', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '查看完整号码' }).click()
  await expect(page.getByText('查看完整银行卡号')).toBeVisible()
  await page.getByRole('button', { name: '确认查看' }).click()
  await expect(page.getByText('6222020200112233445', { exact: true })).toBeVisible()
  const calls = await page.evaluate(() => window.__revealCalls)
  expect(calls).toContain('bank.reveal')
})

test.describe('银行卡移动端响应式布局', () => {
  for (const width of [320, 340, 375, 390, 430]) {
    test(`${width}px 掩码与完整号码均无溢出或重叠`, async ({ page }) => {
      await openBankCard(page, { width })
      expectStableBankCardLayout(await bankCardGeometry(page))

      await revealBankCard(page)
      expectStableBankCardLayout(await bankCardGeometry(page), { revealed: true })
      await expect(page.getByRole('button', { name: '复制' })).toHaveText('复制')
      await expect(page.getByRole('button', { name: '隐藏' })).toBeVisible()
      await expect(page.getByTestId('bank-card-holder')).toContainText('隋晓')
      await expect(page.getByTestId('bank-card-payroll-badge')).toHaveText('工资卡')
      await expect(page.getByTestId('bank-card-audit-notice')).toContainText('查看将记录审计日志')
    })
  }

  test('340px 更新流程打开和关闭均无横向溢出', async ({ page }) => {
    await openBankCard(page, { width: 340 })
    await page.getByRole('button', { name: '更新' }).click()
    await expect(page.getByPlaceholder('8-25 位卡号')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true)
    await expect(page.getByRole('button', { name: '取消' })).toHaveCSS('white-space', 'nowrap')
    await expect(page.getByRole('button', { name: '保存（加密存储）' })).toHaveCSS('white-space', 'nowrap')
    await page.getByRole('button', { name: '取消' }).click()
    await expect(page.getByTestId('bank-card')).toBeVisible()
  })

  test('320px 长银行名、长持卡人和 25 位安全测试卡号保持稳定', async ({ page }) => {
    await openBankCard(page, { width: 320, stress: true })
    await expect(page.getByTestId('bank-card-bank-name')).toContainText('特别长名称测试支行')
    await expect(page.getByTestId('bank-card-holder')).toContainText('安全测试持卡人超长姓名示例')
    expectStableBankCardLayout(await bankCardGeometry(page))

    await revealBankCard(page)
    await expect(page.getByTestId('bank-card-number')).toHaveText('6222020200112233445566778')
    expectStableBankCardLayout(await bankCardGeometry(page), { revealed: true })
  })

  test('iPad 竖屏与桌面布局回归', async ({ page }) => {
    for (const viewport of [{ width: 768, height: 1024 }, { width: 1280, height: 900 }]) {
      await openBankCard(page, viewport)
      expectStableBankCardLayout(await bankCardGeometry(page))
      await revealBankCard(page)
      expectStableBankCardLayout(await bankCardGeometry(page), { revealed: true })
    }
  })
})

test('基本信息空字段显示「暂未填写」', async ({ page }) => {
  await page.getByText(/隋晓/).first().click()
  await page.getByRole('button', { name: '基本信息' }).click()
  await expect(page.getByText('暂未填写', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('13800000000', { exact: true })).toBeVisible()
})

test('履历时间线展示入职与调薪记录', async ({ page }) => {
  await page.getByText(/隋晓/).first().click()
  await page.getByRole('button', { name: '履历时间线' }).click()
  await expect(page.getByText(/入职/).first()).toBeVisible()
  await expect(page.getByText(/薪资调整/).first()).toBeVisible()
  await expect(page.getByText(/4000 → 4500/)).toBeVisible()
  await expect(page.getByText('操作人：budu')).toBeVisible()
})

test('工资考勤摘要展示只读数据', async ({ page }) => {
  await page.getByText(/隋晓/).first().click()
  await page.getByRole('button', { name: '工资考勤' }).click()
  await expect(page.getByText('22 天', { exact: true })).toBeVisible()
  await expect(page.getByText('累计 176 小时')).toBeVisible()
  await expect(page.getByText('¥4500.00', { exact: true })).toBeVisible()
  await expect(page.getByText('已签收', { exact: true })).toBeVisible()
})

test('附件空态显示「暂未填写」', async ({ page }) => {
  await page.getByText(/隋晓/).first().click()
  await page.getByRole('button', { name: '附件' }).click()
  await expect(page.getByText('暂未填写', { exact: true }).first()).toBeVisible()
  await expect(page.getByText(/上传附件（≤4MB）/).first()).toBeVisible()
})

test('角色矩阵：finance 可 reveal 银行卡、不可 reveal 身份证', async ({ page }) => {
  await page.goto('/tests/employee-profile-harness.html?mode=finance')
  await page.getByText(/隋晓/).first().click()
  // 身份证：无 reveal 按钮，显示无权限提示
  await page.getByRole('button', { name: '身份信息' }).click()
  await expect(page.getByText('110101********1234', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '查看完整号码' })).toHaveCount(0)
  await expect(page.getByText('无查看完整号码权限')).toBeVisible()
  // 银行卡：finance 可 reveal
  await page.getByRole('button', { name: '银行卡' }).click()
  await page.getByRole('button', { name: '查看完整号码' }).click()
  await page.getByRole('button', { name: '确认查看' }).click()
  await expect(page.getByText('6222020200112233445', { exact: true })).toBeVisible()
})

test('角色矩阵：manager 无 reveal 权限；staff 无模块访问', async ({ page }) => {
  // manager：可查看档案但不可 reveal
  await page.goto('/tests/employee-profile-harness.html?mode=manager')
  await page.getByText(/隋晓/).first().click()
  await page.getByRole('button', { name: '身份信息' }).click()
  await expect(page.getByText('110101********1234', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '查看完整号码' })).toHaveCount(0)
  await expect(page.getByText('无查看完整号码权限')).toBeVisible()
  // staff：模块默认不开放，页面显示无权限
  await page.goto('/tests/employee-profile-harness.html?mode=staff')
  await expect(page.getByText('无权限访问员工档案')).toBeVisible()
})

test('开发者可发起离职操作（离职 ≠ 删除：确认弹窗提示档案保留）', async ({ page }) => {
  await page.getByText(/隋晓/).first().click()
  await page.getByRole('button', { name: '任职信息' }).click()
  await page.getByRole('button', { name: '离职' }).click()
  await expect(page.getByText('确认办理离职？')).toBeVisible()
  await expect(page.getByText(/离职 ≠ 删除/)).toBeVisible()
  await page.getByRole('button', { name: '确认离职' }).click()
  await expect(page.getByText(/已离职（履历已记录）/)).toBeVisible()
})

test('Gate 7 D: 带 Employee.id 跳转直达正确档案（不按姓名搜索命中）', async ({ page }) => {
  await page.goto('/tests/employee-profile-harness.html?mode=developer&initialId=emp-test-1')
  // 直接进入指定员工详情（档案详情标题 + 基本信息 Tab）
  await expect(page.getByText(/档案详情/)).toBeVisible()
  await expect(page.getByRole('button', { name: '基本信息' })).toBeVisible()
  await expect(page.getByText(/隋晓/).first()).toBeVisible()
  // 列表搜索框不应出现（未走姓名搜索）
  await expect(page.getByPlaceholder('搜索姓名 / 员工编号 / 手机号')).toHaveCount(0)
})
