import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'

const root = resolve(import.meta.dirname, '..')

test('语言切换与内置静态历史包已从运行代码移除', () => {
  for (const relative of [
    'src/i18n.jsx',
    'src/locales.js',
    'src/data/reportData.js',
    'src/data/_legacy_mockData.js',
    'scripts/build_report_data.py',
  ]) {
    assert.equal(existsSync(resolve(root, relative)), false, `${relative} 不应继续存在`)
  }

  const settings = readFileSync(resolve(root, 'src/components/SettingsPage.jsx'), 'utf8')
  const selectors = readFileSync(resolve(root, 'src/utils/selectors.js'), 'utf8')
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  assert.doesNotMatch(settings, /界面语言|setLang|useI18n|budu-os-lang/)
  assert.doesNotMatch(selectors, /reportData|_legacy_mockData/)
  assert.equal(packageJson.devDependencies?.['vite-plugin-singlefile'], undefined)
})

test('固定中文文本适配层保留动态占位能力', async () => {
  const { t } = await import('../src/utils/text.js')
  assert.equal(t('{month} 汇总 · {store}', { month: '2026年08月', store: '官舍店' }), '2026年08月 汇总 · 官舍店')
  assert.equal(t('没有占位符'), '没有占位符')
})

test('员工主档独立于历史报表并保留原全职兼职设置', async () => {
  const { BASE_EMPLOYEES } = await import('../src/data/baseEmployees.js')
  assert.equal(BASE_EMPLOYEES.length, 10)
  assert.deepEqual(
    BASE_EMPLOYEES.filter((row) => row.type === 'fulltime').map((row) => row.name),
    ['隋晓', '叶芷辰', '李飞燕'],
  )
  assert.deepEqual(
    BASE_EMPLOYEES.filter((row) => row.type === 'parttime').map((row) => row.name),
    ['左可翠', '陈文慧', '舒敏', '史璐璐', '马婧欣', '龚艺锦', '王红云'],
  )
})

test('月份列表只从云端分析、每日录入和 POS 汇总派生', async () => {
  const mirror = {
    analysis: { months: ['2026-09'] },
    entries: { '2026-10|guanshe|10-01': { inc: 1, ord: 1, staff: [] } },
    posDaily: [{ date: '2026-11-02', storeKey: 'guanshe' }],
  }
  const server = await createServer({
    root,
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  try {
    const { seedCachedDataForTest } = await server.ssrLoadModule('/src/utils/userData.js')
    seedCachedDataForTest(mirror)
    const { allMonths, employeeList } = await server.ssrLoadModule('/src/utils/selectors.js')
    assert.deepEqual(allMonths().map((row) => row.key), ['2026-09', '2026-10', '2026-11'])
    const staff = employeeList('all', '2026-10')
    assert.equal(staff.filter((row) => row.type === 'fulltime').length, 3)
    assert.equal(staff.filter((row) => row.type === 'parttime').length, 7)
  } finally {
    await server.close()
  }
})
