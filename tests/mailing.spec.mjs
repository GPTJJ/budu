import { expect, test } from '@playwright/test'

test('门店邮寄提交成功后清空表单与本地存档，重开页面不残留', async ({ page }) => {
  await page.goto('/tests/mailing-harness.html')
  await page.getByPlaceholder('请输入收件地址').fill('测试地址路1号')
  await page.getByPlaceholder('请输入收件人姓名').fill('测试收件人')
  await page.getByPlaceholder('请输入手机号 / 电话').fill('13800000000')
  await page.getByPlaceholder('商品信息及数量，顾客指定时间').fill('备注测试')
  await page.getByRole('button', { name: '提交', exact: true }).click()
  await expect(page.getByText('已提交发件单，表单已清空 ✓', { exact: true })).toBeVisible()
  await expect(page.getByPlaceholder('请输入收件地址')).toHaveValue('')
  await expect(page.getByPlaceholder('请输入收件人姓名')).toHaveValue('')
  await expect(page.getByPlaceholder('请输入手机号 / 电话')).toHaveValue('')
  await expect(page.getByPlaceholder('商品信息及数量，顾客指定时间')).toHaveValue('')
  const stored = await page.evaluate(() => {
    const raw = localStorage.getItem('budu-store-mailing')
    return raw ? JSON.parse(raw) : null
  })
  expect(stored).not.toBeNull()
  expect(stored.address).toBe('')
  expect(stored.recipient).toBe('')
  expect(stored.phone).toBe('')
  expect(stored.remark).toBe('')

  await page.reload()
  await expect(page.getByPlaceholder('请输入收件地址')).toHaveValue('')
  await expect(page.getByPlaceholder('请输入收件人姓名')).toHaveValue('')
  await expect(page.getByPlaceholder('请输入手机号 / 电话')).toHaveValue('')
})
