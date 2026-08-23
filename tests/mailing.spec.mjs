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

test('智能识别：粘贴文本自动拆分姓名/电话/地址并填入', async ({ page }) => {
  await page.goto('/tests/mailing-harness.html')
  await page.getByPlaceholder('「粘贴识别」或输入文本，智能拆分姓名、电话和地址').fill('张三 13800138000 北京市朝阳区望京街道阜通东大街6号院3号楼1201室')
  await page.getByRole('button', { name: '粘贴并识别' }).click()
  await expect(page.getByPlaceholder('请输入收件人姓名')).toHaveValue('张三')
  await expect(page.getByPlaceholder('请输入手机号 / 电话')).toHaveValue('13800138000')
  await expect(page.getByPlaceholder('请输入收件地址')).toHaveValue('北京市朝阳区望京街道阜通东大街6号院3号楼1201室')
  await expect(page.getByText(/已识别/)).toBeVisible()
})

test('智能识别：带标签文本（收件人/电话/地址）', async ({ page }) => {
  await page.goto('/tests/mailing-harness.html')
  await page.getByPlaceholder('「粘贴识别」或输入文本，智能拆分姓名、电话和地址').fill('收件人：李四\n电话：13912345678\n地址：上海市浦东新区张江路88号')
  await page.getByRole('button', { name: '粘贴并识别' }).click()
  await expect(page.getByPlaceholder('请输入收件人姓名')).toHaveValue('李四')
  await expect(page.getByPlaceholder('请输入手机号 / 电话')).toHaveValue('13912345678')
  await expect(page.getByPlaceholder('请输入收件地址')).toHaveValue('上海市浦东新区张江路88号')
})

test('智能识别：空文本提示且不误填', async ({ page }) => {
  await page.goto('/tests/mailing-harness.html')
  await page.getByRole('button', { name: '粘贴并识别' }).click()
  await expect(page.getByText('请先粘贴或输入收件文本')).toBeVisible()
  await expect(page.getByPlaceholder('请输入收件人姓名')).toHaveValue('')
})

test('智能识别：电话+地址（无姓名）只填电话地址', async ({ page }) => {
  await page.goto('/tests/mailing-harness.html')
  await page.getByPlaceholder('「粘贴识别」或输入文本，智能拆分姓名、电话和地址').fill('13800138000 北京市海淀区中关村大街1号')
  await page.getByRole('button', { name: '粘贴并识别' }).click()
  await expect(page.getByPlaceholder('请输入手机号 / 电话')).toHaveValue('13800138000')
  await expect(page.getByPlaceholder('请输入收件地址')).toHaveValue('北京市海淀区中关村大街1号')
})
