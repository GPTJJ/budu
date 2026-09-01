import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')
const hash = (relative) => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex')

test('canonical logo source and vector derivative preserve measured geometry', () => {
  assert.equal(hash('brand/source/budu-wordmark.pdf'), '25a4911c83fdf79d75eea023333be89700aaafb8e2aa5a275d9c6d249208b209')
  const svg = read('brand/web/budu-wordmark.svg')
  assert.match(svg, /viewBox="222\.5192 233\.8839 396\.8512 127\.5082"/)
  assert.match(svg, /fill="#050707"/)
  assert.doesNotMatch(svg, /<text\b/i)
  assert.equal(fs.existsSync(path.join(root, 'brand/document/budu-wordmark-1600.png')), true)
})

test('brand skill is discoverable and router composes it for user-visible output', () => {
  const skill = read('.agents/skills/budu-brand-system/SKILL.md')
  const router = read('.agents/skills/budu-task-router/SKILL.md')
  assert.match(skill, /^---\nname: budu-brand-system\n/m)
  assert.match(skill, /formal name is always lowercase `budu`/)
  assert.match(skill, /Formal logo positions must use `brand\/source\/budu-wordmark\.pdf`/)
  assert.match(router, /also `budu-brand-system`/)
})

test('formal web brand positions use the canonical derivative', () => {
  for (const file of ['src/components/LoginPage.jsx', 'src/components/BrandSlot.jsx']) {
    const source = read(file)
    assert.match(source, /brand\/web\/budu-wordmark\.svg/)
    assert.doesNotMatch(source, />\s*BUDU\s*</)
  }
})

test('system brand slot composes the controlled icon with the unchanged wordmark', () => {
  const brandSlot = read('src/components/BrandSlot.jsx')
  const sidebar = read('src/components/Sidebar.jsx')
  assert.equal(hash('brand/source/budu-brand-slot-icon-source.png'), '0a64969e00313d33093734f6438720206c832e730289c2b73309097aa8083745')
  assert.equal(hash('brand/web/budu-brand-slot-icon.png'), 'cf6222f41ca8731295cc6bd2e7dde6346920f56a6d41e4ce4d81f953070d93a2')
  assert.match(brandSlot, /brand\/web\/budu-brand-slot-icon\.png/)
  assert.match(brandSlot, /brand\/web\/budu-wordmark\.svg/)
  assert.match(brandSlot, /alt="budu"/)
  assert.match(brandSlot, /object-contain/)
  assert.match(brandSlot, /data-testid="brand-slot-wordmark"/)
  assert.match(brandSlot, /outline: 'none'/)
  assert.match(brandSlot, /background: 'transparent'/)
  assert.match(sidebar, /<BrandSlot \/>/)
  assert.doesNotMatch(sidebar, /甜蜜治愈日常/)
})

test('POS header is lowercase and the release forces stale PWA sessions to refresh', () => {
  const pos = read('src/components/PosPage.jsx')
  const serviceWorker = read('public/sw.js')
  const main = read('src/main.jsx')
  assert.match(pos, />budu POS<\/strong>/)
  assert.doesNotMatch(pos, />BUDU POS<\/strong>/)
  assert.match(serviceWorker, /budu-shell-v18/)
  assert.match(serviceWorker, /self\.skipWaiting\(\)/)
  assert.match(main, /controllerchange/)
  assert.match(main, /window\.location\.reload\(\)/)
})

test('payroll report user-facing outputs use lowercase budu and canonical wordmark', () => {
  const source = read('server/payroll-audit-report.js')
  const store = read('server/payroll-audit-run-store.js')
  assert.match(source, /WORDMARK_DATA_URI/)
  assert.match(source, /<img class="brand-wordmark"/)
  assert.match(source, /`budu｜\$\{year\}年\$\{month\}月薪酬审查报告/)
  assert.match(source, /'# budu 薪酬审查报告'/)
  assert.match(store, /`budu_\$\{month\}_薪酬审查报告`/)
})

test('internal and historical identifiers remain untouched', () => {
  assert.match(read('src/components/ProductCenterPage.jsx'), /BUDU-12Y/)
  assert.match(read('server/employee-profile.js'), /BUDU-/)
  assert.match(read('server/payments/providers/wechat-pay.js'), /body: 'BUDU'/)
})
