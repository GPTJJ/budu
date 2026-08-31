import { expect, test } from '@playwright/test'

function notificationsFixture() {
  const origin = Date.parse('2026-08-31T12:00:00.000Z')
  return Array.from({ length: 7 }, (_, index) => ({
    id: `notification-${index + 1}`,
    title: `通知 ${index + 1}`,
    content: '未读状态同步测试',
    status: index < 4 ? 'unread' : 'read',
    priority: 'normal',
    target: '',
    createdAt: new Date(origin + index * 1000).toISOString(),
  }))
}

async function installAuthority(page, { failMarkAll = false, concurrentNew = false } = {}) {
  const state = { rows: notificationsFixture(), deliveriesTouched: 0 }
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const empty = () => route.fulfill({ json: { ok: true, rows: [] } })
    if (url.pathname === '/api/v2/notifications' && request.method() === 'GET') {
      const visible = state.rows.filter((row) => row.status !== 'deleted')
      const unread = visible.filter((row) => row.status === 'unread')
      return route.fulfill({ json: {
        ok: true,
        rows: url.searchParams.get('unread') === '1' ? unread : visible,
        totalCount: visible.length,
        unreadCount: unread.length,
      } })
    }
    if (url.pathname === '/api/v2/notifications/read' && request.method() === 'POST') {
      const body = request.postDataJSON()
      if (body.all === true && failMarkAll) return route.fulfill({ status: 500, json: { error: '标记全部已读失败' } })
      const through = body.through ? Date.parse(body.through) : Infinity
      if (body.all === true && concurrentNew && !state.rows.some((row) => row.id === 'notification-new')) {
        state.rows.push({
          id: 'notification-new',
          title: '新通知',
          content: '并发到达',
          status: 'unread',
          priority: 'normal',
          target: '',
          createdAt: new Date(through + 1000).toISOString(),
        })
      }
      const ids = new Set(body.ids || [])
      state.rows = state.rows.map((row) => {
        const selected = body.all === true ? Date.parse(row.createdAt) <= through : ids.has(row.id)
        return selected && row.status === 'unread' ? { ...row, status: 'read', readAt: new Date().toISOString() } : row
      })
      const unreadCount = state.rows.filter((row) => row.status === 'unread').length
      return route.fulfill({ json: { ok: true, unreadCount, totalCount: state.rows.length } })
    }
    if (url.pathname === '/api/v2/approvals/notifications' || url.pathname === '/api/v2/payroll-notices' || url.pathname === '/api/v2/invoices' || url.pathname === '/api/v2/mailing-records' || url.pathname === '/api/v2/asset-center/reminders' || url.pathname === '/api/v2/stock/alerts') return empty()
    if (url.pathname.includes('/api/userdata')) return route.fulfill({ json: { ok: true, data: {} } })
    return empty()
  })
  return state
}

const bell = (page) => page.getByRole('button', { name: '查看通知' }).filter({ visible: true })

for (const width of [390, 1024]) {
  test(`${width}px 单条与全部已读即时同步 Badge，刷新后保持`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await installAuthority(page)
    await page.goto('/tests/notification-unread-harness.html')
    await expect(bell(page)).toContainText('4')

    await bell(page).click()
    const dialog = page.getByRole('dialog', { name: '通知' })
    await expect(dialog).toContainText('通知7')
    await dialog.getByRole('button', { name: /通知 1/ }).click()
    await expect(bell(page)).toContainText('3')

    await bell(page).click()
    await dialog.getByRole('button', { name: '全部已读' }).click()
    await expect(bell(page)).not.toContainText(/[1-9]/)
    await expect(dialog).toContainText('通知7')
    await page.keyboard.press('Escape').catch(() => {})
    await page.reload()
    await expect(bell(page)).not.toContainText(/[1-9]/)
    await bell(page).click()
    await expect(page.getByRole('dialog', { name: '通知' })).toContainText('通知7')
  })
}

test('mark-all 失败保留 Badge，并发新通知保持未读', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await installAuthority(page, { failMarkAll: true })
  await page.goto('/tests/notification-unread-harness.html')
  await expect(bell(page)).toContainText('4')
  await bell(page).click()
  await page.getByRole('button', { name: '全部已读' }).click()
  await expect(page.getByRole('alert')).toContainText('标记全部已读失败')
  await expect(bell(page)).toContainText('4')

  await page.unrouteAll({ behavior: 'wait' })
  await installAuthority(page, { concurrentNew: true })
  await page.reload()
  await bell(page).click()
  await page.getByRole('button', { name: '全部已读' }).click()
  await expect(bell(page)).toContainText('1')
})

test('320/340/375/390/430 通知面板无横向溢出', async ({ page }) => {
  await installAuthority(page)
  for (const width of [320, 340, 375, 390, 430]) {
    await page.setViewportSize({ width, height: 844 })
    await page.goto('/tests/notification-unread-harness.html')
    await bell(page).click()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    await expect(page.getByRole('dialog', { name: '通知' })).toBeVisible()
  }
})
