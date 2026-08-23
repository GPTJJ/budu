// 发票开具页智能识别（粘贴/语音拆分抬头/税号/金额）E2E
import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/invoice-harness.html')
})

test('粘贴识别：拆分抬头/税号/金额并填入', async ({ page }) => {
  await page.getByPlaceholder('「粘贴识别」或输入文本，智能拆分抬头、税号和金额').fill('抬头：北京某某科技有限公司 税号：91110108MA01ABCD2X 金额：500元')
  await page.getByRole('button', { name: '粘贴并识别' }).click()
  // 名称字典命中：应自动匹配税号
  await expect(page.getByPlaceholder('公司名称（输入自动匹配税号）')).toHaveValue('北京某某科技有限公司')
  await expect(page.getByPlaceholder('公司税号（自动匹配，可修改）')).toHaveValue('91110108MA01ABCD2X')
  await expect(page.getByPlaceholder('开票金额（元）')).toHaveValue('500')
  await expect(page.getByText(/已识别/)).toBeVisible()
})

test('粘贴识别：自由文本（公司名 税号 ¥金额）', async ({ page }) => {
  await page.getByPlaceholder('「粘贴识别」或输入文本，智能拆分抬头、税号和金额').fill('上海某某贸易有限公司 91310115MA1K3XXXXX ¥1234.56')
  await page.getByRole('button', { name: '粘贴并识别' }).click()
  await expect(page.getByPlaceholder('公司名称（输入自动匹配税号）')).toHaveValue('上海某某贸易有限公司')
  await expect(page.getByPlaceholder('公司税号（自动匹配，可修改）')).toHaveValue('91310115MA1K3XXXXX')
  await expect(page.getByPlaceholder('开票金额（元）')).toHaveValue('1234.56')
})

test('粘贴识别：空文本提示且不误填', async ({ page }) => {
  await page.getByRole('button', { name: '粘贴并识别' }).click()
  await expect(page.getByText('请先粘贴或输入开票文本')).toBeVisible()
  await expect(page.getByPlaceholder('公司名称（输入自动匹配税号）')).toHaveValue('')
})

test('粘贴识别：个人抬头', async ({ page }) => {
  await page.getByPlaceholder('「粘贴识别」或输入文本，智能拆分抬头、税号和金额').fill('张三 200元')
  await page.getByRole('button', { name: '粘贴并识别' }).click()
  await expect(page.getByPlaceholder('个人姓名 / 抬头')).toHaveValue('张三')
  await expect(page.getByPlaceholder('开票金额（元）')).toHaveValue('200')
})
