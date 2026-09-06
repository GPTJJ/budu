import { expect, test } from '@playwright/test'

test('Sweet Card 管理页统一显示中文 enum label，仍使用原始 enum 筛选和提交', async ({ page }) => {
  await page.goto('/tests/sweet-card-admin-harness.html')

  await page.getByRole('button', { name: '批次', exact: true }).click()
  await expect(page.getByText('7 张 · ¥200.00 · 电子卡 · 必须绑定')).toBeVisible()

  await page.getByRole('button', { name: '卡片', exact: true }).click()
  const statusFilter = page.getByLabel('按状态筛选')
  await expect(statusFilter.locator('option')).toHaveText(['全部状态', '已创建', '已激活', '已冻结', '已挂失', '已用尽', '已过期', '已作废'])
  expect(await statusFilter.locator('option').evaluateAll((options) => options.map((option) => option.value))).toEqual(['', 'CREATED', 'ACTIVE', 'FROZEN', 'LOST', 'EXHAUSTED', 'EXPIRED', 'VOID'])
  await expect(page.getByText('电子卡 · 不绑定 · 已创建')).toBeVisible()
  await expect(page.getByText('实体卡 · 可选绑定 · 已激活')).toBeVisible()

  const requestsBeforeFilter = await page.evaluate(() => window.__sweetCardListRequests)
  await statusFilter.selectOption({ label: '已冻结' })
  await expect(statusFilter).toHaveValue('FROZEN')
  await expect(page.getByText('SC-UI-03')).toBeVisible()
  await expect(page.getByText('SC-UI-02')).toHaveCount(0)
  expect(await page.evaluate(() => window.__sweetCardListRequests)).toBe(requestsBeforeFilter)

  await page.getByRole('button', { name: '详情 / Ledger' }).click()
  const detail = page.getByRole('dialog', { name: '甜意卡详情' })
  await expect(detail.getByText('已冻结', { exact: true })).toBeVisible()
  await expect(detail.getByText('电子卡 / 必须绑定', { exact: true })).toBeVisible()
  await detail.getByRole('button', { name: '关闭' }).click()

  await page.getByRole('button', { name: '发卡', exact: true }).click()
  const carrier = page.getByLabel('载体')
  const binding = page.getByLabel('绑定模式')
  await expect(carrier.locator('option')).toHaveText(['实体卡', '电子卡'])
  expect(await carrier.locator('option').evaluateAll((options) => options.map((option) => option.value))).toEqual(['PHYSICAL', 'ELECTRONIC'])
  await expect(binding.locator('option')).toHaveText(['不绑定', '可选绑定', '必须绑定'])
  expect(await binding.locator('option').evaluateAll((options) => options.map((option) => option.value))).toEqual(['NONE', 'OPTIONAL', 'REQUIRED'])
  await carrier.selectOption({ label: '电子卡' })
  await binding.selectOption({ label: '可选绑定' })
  await page.getByLabel('批次名称').fill('UI-中文化-测试')
  await page.getByLabel('面额（元）').fill('500.00')
  await page.getByRole('button', { name: '创建甜意卡批次' }).click()
  await expect.poll(() => page.evaluate(() => window.__lastSweetCardBatchBody)).toMatchObject({
    name: 'UI-中文化-测试', faceValueYuan: '500.00', carrierType: 'ELECTRONIC', bindingMode: 'OPTIONAL', businessPurpose: 'COMMERCIAL',
  })
})

test('A7.5 电子卡发放使用领取凭证，保存展示信息并在显式确认后激活', async ({ page }) => {
  await page.goto('/tests/sweet-card-admin-harness.html')
  await page.getByRole('button', { name: '卡片', exact: true }).click()
  const card = page.locator('article').filter({ hasText: 'SC-UI-01' })
  await card.getByRole('button', { name: '详情 / Ledger' }).click()
  const detail = page.getByRole('dialog', { name: '甜意卡详情' })
  const deliverySection = detail.getByRole('region', { name: '电子卡发放' })

  await expect(detail.getByRole('heading', { name: '电子卡发放' })).toBeVisible()
  await expect(detail.getByText('BUDU-SC-202609-A01')).toBeVisible()
  await expect(deliverySection.getByLabel('电子卡状态')).toContainText('未生成')
  await expect(deliverySection.getByLabel('领取状态')).toContainText('未领取')
  await expect(deliverySection.getByLabel('激活状态')).toContainText('未激活')
  await expect(detail.getByRole('paragraph').filter({ hasText: /^使用凭证/ })).toContainText('未激活')
  await expect(detail.getByRole('button', { name: '激活并准备发放' })).toBeDisabled()
  const economicBeforeGeneration = await detail.getByRole('region', { name: '卡片概况' }).textContent()
  const ledgerRowsBeforeGeneration = await detail.getByRole('region', { name: '账务记录' }).locator('[class*="justify-between"]').count()

  await detail.getByLabel('赠送对象', { exact: true }).fill('林女士')
  await detail.getByLabel('祝福语 / campaign 文案').fill('愿每一天都有一点甜。')
  await detail.getByRole('button', { name: '保存赠送信息' }).click()
  await expect.poll(() => page.evaluate(() => window.__presentationUpdates.at(-1))).toMatchObject({
    recipientLabel: '林女士', recipientNote: '愿每一天都有一点甜。',
  })

  page.once('dialog', (dialog) => dialog.accept())
  await detail.getByRole('button', { name: '生成电子卡' }).click()
  const delivery = page.getByRole('dialog', { name: '电子卡交付' })
  await expect(delivery.getByRole('heading', { name: '电子卡已生成' })).toBeVisible()
  await expect(delivery.getByText(/微信扫码领取甜意卡/)).toBeVisible()
  await expect(delivery.getByRole('img', { name: '微信扫码领取甜意卡卡面预览' })).toBeVisible()
  await expect(delivery.getByRole('button', { name: '下载电子卡图片' })).toBeEnabled()
  const downloadPromise = page.waitForEvent('download')
  await delivery.getByRole('button', { name: '下载电子卡图片' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('SC-UI-01.claim.electronic.svg')
  expect(await delivery.textContent()).not.toContain('FAKE-PROOF-FOR-UI-HARNESS')
  await delivery.getByRole('button', { name: '关闭' }).click()

  await expect(deliverySection.getByLabel('电子卡状态')).toContainText('已生成')
  await expect(deliverySection.getByLabel('领取凭证状态')).toContainText('有效')
  expect(await detail.getByRole('region', { name: '卡片概况' }).textContent()).toBe(economicBeforeGeneration)
  expect(await detail.getByRole('region', { name: '账务记录' }).locator('[class*="justify-between"]').count()).toBe(ledgerRowsBeforeGeneration)
  page.once('dialog', (dialog) => dialog.accept())
  await detail.getByRole('button', { name: '重新生成领取凭证' }).click()
  await expect(page.getByRole('dialog', { name: '电子卡交付' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.__claimPresentationBodies.at(-1)?.reissueConfirmed)).toBe(true)
  await page.getByRole('dialog', { name: '电子卡交付' }).getByRole('button', { name: '关闭' }).click()
  expect(await detail.getByRole('region', { name: '卡片概况' }).textContent()).toBe(economicBeforeGeneration)
  expect(await detail.getByRole('region', { name: '账务记录' }).locator('[class*="justify-between"]').count()).toBe(ledgerRowsBeforeGeneration)
  await expect(detail.getByRole('button', { name: '激活并准备发放' })).toBeEnabled()
  page.once('dialog', (dialog) => dialog.accept())
  await detail.getByRole('button', { name: '激活并准备发放' }).click()
  await expect(deliverySection.getByLabel('激活状态')).toContainText('已激活')
  await expect(deliverySection.getByLabel('发放准备状态')).toContainText('已准备发放')
  await expect.poll(() => page.evaluate(() => window.__deliveryActions)).toContain('ACTIVATE')

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('Sweet Card 三个运营视图按 purpose 与 archivedAt 隔离，并可审计式归档和恢复', async ({ page }) => {
  await page.goto('/tests/sweet-card-admin-harness.html')
  await page.getByRole('button', { name: '批次', exact: true }).click()

  await expect(page.getByText('BUDU-SC-202609-A01')).toBeVisible()
  await expect(page.getByText('P19-验收事实')).toHaveCount(0)
  await expect(page.getByText('历史商业批次')).toHaveCount(0)

  await page.getByRole('button', { name: '测试/验收', exact: true }).click()
  await expect(page.getByText('P19-验收事实')).toBeVisible()
  await expect(page.getByText('BUDU-SC-202609-A01')).toHaveCount(0)

  await page.getByRole('button', { name: '已归档', exact: true }).click()
  await expect(page.getByText('历史商业批次')).toBeVisible()
  await expect(page.getByText('历史验收批次')).toBeVisible()
  await expect(page.locator('span').filter({ hasText: /^商业运营$/ })).toBeVisible()
  await expect(page.locator('span').filter({ hasText: /^测试\/验收$/ })).toBeVisible()

  await page.getByRole('button', { name: '商业运营', exact: true }).click()
  const batchCard = page.locator('article').filter({ has: page.getByRole('heading', { name: 'BUDU-SC-202609-A01' }) })
  await batchCard.getByText('批次操作').click()
  page.once('dialog', (dialog) => dialog.accept())
  await batchCard.getByRole('button', { name: '归档批次' }).click()
  await expect(page.getByText('BUDU-SC-202609-A01')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => window.__archiveActions)).toContainEqual({ id: 'batch-commercial', action: 'archive' })

  await page.getByRole('button', { name: '已归档', exact: true }).click()
  const archivedCard = page.locator('article').filter({ has: page.getByRole('heading', { name: 'BUDU-SC-202609-A01' }) })
  await expect(archivedCard.getByText('已归档', { exact: true })).toBeVisible()
  await archivedCard.getByText('批次操作').click()
  await archivedCard.getByRole('button', { name: '恢复归档' }).click()
  await expect(page.getByText('BUDU-SC-202609-A01')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => window.__archiveActions)).toContainEqual({ id: 'batch-commercial', action: 'restore' })

  await page.getByRole('button', { name: '商业运营', exact: true }).click()
  await expect(page.getByText('BUDU-SC-202609-A01')).toBeVisible()
})

for (const width of [320, 340, 375, 390, 430]) {
  test(`${width}px Sweet Card 中文 label 无横向溢出`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await page.goto('/tests/sweet-card-admin-harness.html')
    await expect(page.getByRole('button', { name: '测试/验收', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '已归档', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '卡片', exact: true }).click()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.getByLabel('按状态筛选').selectOption('FROZEN')
    await page.getByRole('button', { name: '详情 / Ledger' }).click()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.getByRole('button', { name: '关闭' }).click()
    await page.getByRole('button', { name: '发卡', exact: true }).click()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
}
