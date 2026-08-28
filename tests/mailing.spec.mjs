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

test('智能识别：粘贴文本自动拆分姓名/电话/地址/备注并填入', async ({ page }) => {
  await page.goto('/tests/mailing-harness.html')
  await page.getByPlaceholder('「粘贴识别」或输入文本，智能拆分姓名、电话和地址').fill(
    '张三\n13800138000\n北京市朝阳区XX街道XX小区2号楼3单元401\n巧克力2盒，下午送',
  )
  await page.getByRole('button', { name: '粘贴并识别' }).click()
  await expect(page.getByPlaceholder('请输入收件人姓名')).toHaveValue('张三')
  await expect(page.getByPlaceholder('请输入手机号 / 电话')).toHaveValue('13800138000')
  await expect(page.getByPlaceholder('请输入收件地址')).toHaveValue('北京市朝阳区XX街道XX小区2号楼3单元401')
  await expect(page.getByPlaceholder('商品信息及数量，顾客指定时间')).toHaveValue('巧克力2盒，下午送')
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

test('智能识别：再次识别只填空字段，保留手工值', async ({ page }) => {
  await page.goto('/tests/mailing-harness.html')
  const source = page.getByPlaceholder('「粘贴识别」或输入文本，智能拆分姓名、电话和地址')
  const name = page.getByPlaceholder('请输入收件人姓名')
  await source.fill('张三\n13800138000\n北京市朝阳区XX路2号\n巧克力2盒')
  await page.getByRole('button', { name: '粘贴并识别' }).click()
  await name.fill('手工姓名')
  await source.fill('李四\n13912345678\n上海市浦东新区XX路8号\n蛋糕1个')
  await page.getByRole('button', { name: '粘贴并识别' }).click()
  await expect(name).toHaveValue('手工姓名')
  await expect(page.getByPlaceholder('请输入手机号 / 电话')).toHaveValue('13800138000')
  await expect(page.getByPlaceholder('请输入收件地址')).toHaveValue('北京市朝阳区XX路2号')
  await expect(page.getByPlaceholder('商品信息及数量，顾客指定时间')).toHaveValue('巧克力2盒')
})

test('图片 OCR 文本与语音文本都进入同一 parser', async ({ page }) => {
  await page.addInitScript(() => {
    window.SpeechRecognition = class {
      start() {
        queueMicrotask(() => {
          this.onresult?.({ results: [[{ transcript: '周小雨\n13600000000\n广东省深圳市测试区示例街8号\n测试商品1件' }]] })
          this.onend?.()
        })
      }
    }
  })
  await page.goto('/tests/mailing-harness.html')
  await page.locator('input[type="file"]').setInputFiles({
    name: 'synthetic-ocr.png',
    mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
  })
  await expect(page.getByPlaceholder('请输入收件人姓名')).toHaveValue('林小满')
  await expect(page.getByPlaceholder('商品信息及数量，顾客指定时间')).toHaveValue('测试商品2盒')

  await page.getByPlaceholder('请输入收件人姓名').fill('')
  await page.getByPlaceholder('请输入手机号 / 电话').fill('')
  await page.getByPlaceholder('请输入收件地址').fill('')
  await page.getByPlaceholder('商品信息及数量，顾客指定时间').fill('')
  await page.getByRole('button', { name: '语音识别' }).click()
  await expect(page.getByPlaceholder('请输入收件人姓名')).toHaveValue('周小雨')
  await expect(page.getByPlaceholder('请输入手机号 / 电话')).toHaveValue('13600000000')
  await expect(page.getByPlaceholder('请输入收件地址')).toHaveValue('广东省深圳市测试区示例街8号')
  await expect(page.getByPlaceholder('商品信息及数量，顾客指定时间')).toHaveValue('测试商品1件')
})

test('发件记录移动工具栏：日期筛选有明确标签且各宽度无溢出', async ({ page }) => {
  for (const width of [320, 340, 375, 390, 430, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/tests/mailing-harness.html?records=1')
    const toolbar = page.getByTestId('mailing-record-toolbar')
    await expect(toolbar).toBeVisible()
    await expect(toolbar.getByText('开始日期', { exact: true })).toBeVisible()
    await expect(toolbar.getByText('结束日期', { exact: true })).toBeVisible()
    await expect(toolbar.getByRole('button', { name: '待发货（1）' })).toBeVisible()
    await expect(toolbar.getByRole('button', { name: '已发货（1）' })).toBeVisible()
    await expect(toolbar.getByRole('button', { name: '导出 Excel' })).toBeVisible()
    const metrics = await page.evaluate(() => {
      const toolbarElement = document.querySelector('[data-testid="mailing-record-toolbar"]')
      const controls = [...toolbarElement.querySelectorAll('button,input')]
      return {
        viewport: document.documentElement.clientWidth,
        documentWidth: document.documentElement.scrollWidth,
        toolbarRight: toolbarElement.getBoundingClientRect().right,
        clippedControls: controls.filter((element) => {
          const rect = element.getBoundingClientRect()
          return rect.left < 0 || rect.right > document.documentElement.clientWidth + 0.5 || rect.width < 40
        }).length,
      }
    })
    expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewport)
    expect(metrics.toolbarRight).toBeLessThanOrEqual(metrics.viewport + 0.5)
    expect(metrics.clippedControls).toBe(0)
  }
})

test('智能识别表单与复制控件在 320px 保持可编辑且不重叠', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 })
  await page.goto('/tests/mailing-harness.html')
  const metrics = await page.evaluate(() => {
    const copyButtons = [...document.querySelectorAll('button[aria-label^="复制"]')]
    const fields = [...document.querySelectorAll('input,textarea')]
    const overlap = copyButtons.some((button) => {
      const buttonRect = button.getBoundingClientRect()
      return fields.some((field) => {
        const fieldRect = field.getBoundingClientRect()
        return buttonRect.left < fieldRect.right && buttonRect.right > fieldRect.left
          && buttonRect.top < fieldRect.bottom && buttonRect.bottom > fieldRect.top
      })
    })
    return {
      scrollWidth: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth,
      smallestCopyTarget: Math.min(...copyButtons.map((button) => button.getBoundingClientRect().width)),
      overlap,
    }
  })
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.viewport)
  expect(metrics.smallestCopyTarget).toBeGreaterThanOrEqual(44)
  expect(metrics.overlap).toBe(false)
})
