import fs from 'node:fs'
import path from 'node:path'
import { chromium } from '@playwright/test'

export async function renderPayrollAuditPdf(html, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 })
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 1 })
    await page.setContent(html, { waitUntil: 'load' })
    await page.emulateMedia({ media: 'print' })
    await page.pdf({
      path: outputPath,
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: '<div style="width:100%;font:9px -apple-system;color:#8b95a1;text-align:center"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
      margin: { top: '8mm', right: '0', bottom: '11mm', left: '0' },
    })
  } finally {
    await browser.close()
  }
}
