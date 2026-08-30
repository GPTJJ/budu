import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const componentRoot = path.join(root, 'src/components')

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(target)
    return entry.name.endsWith('.jsx') ? [target] : []
  })
}

const inventory = sourceFiles(componentRoot)
  .map((file) => ({ file, source: fs.readFileSync(file, 'utf8') }))
  .filter(({ source }) => /fixed inset-0/.test(source))
  .map(({ file, source }) => ({
    file: path.relative(root, file),
    sharedPrimitive: /OverlayViewport/.test(source),
    explicitDialog: /role=["']dialog["']/.test(source),
    scrollContainer: /overflow-y-auto|budu-overlay-scroll/.test(source),
    mobileSheet: /BottomSheet|items-end/.test(source),
  }))
  .sort((left, right) => left.file.localeCompare(right.file))

test('all full-screen fixed overlays are covered by one stack manager', () => {
  const primitives = fs.readFileSync(path.join(root, 'src/components/overlay/OverlayPrimitives.jsx'), 'utf8')
  assert.match(primitives, /\.fixed\.inset-0/)
  assert.match(primitives, /MutationObserver/)
  assert.match(primitives, /body\.style\.position = 'fixed'/)
  assert.match(primitives, /window\.scrollTo\(previous\.scrollX, previous\.scrollY\)/)
  assert.ok(inventory.length >= 35, `unexpectedly narrow overlay inventory: ${inventory.length}`)
})

test('page-level body scroll locks have been removed', () => {
  const offenders = sourceFiles(componentRoot)
    .filter((file) => !file.endsWith('overlay/OverlayPrimitives.jsx'))
    .filter((file) => /document\.(?:body|documentElement)\.style\.(?:overflow|position|top|width)/.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(root, file))
  assert.deepEqual(offenders, [])
})

test('critical sheets use separated header and scroll regions', () => {
  for (const relative of [
    'src/components/StoreTransferPage.jsx',
    'src/components/PartnerSupplyPage.jsx',
    'src/components/approval/ApprovalSelectors.jsx',
  ]) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8')
    assert.match(source, /OverlayHeader/)
    assert.match(source, /OverlayScrollRegion/)
  }
  const orders = fs.readFileSync(path.join(root, 'src/components/OrderRecordsPage.jsx'), 'utf8')
  assert.match(orders, /budu-overlay-header/)
  assert.match(orders, /budu-overlay-scroll/)
})

test('overlay inventory remains explicit and auditable', () => {
  const summary = {
    totalFiles: inventory.length,
    sharedPrimitiveFiles: inventory.filter((row) => row.sharedPrimitive).map((row) => row.file),
    explicitDialogFiles: inventory.filter((row) => row.explicitDialog).map((row) => row.file),
    legacyFallbackFiles: inventory.filter((row) => !row.sharedPrimitive && !row.explicitDialog).map((row) => row.file),
    independentScrollFiles: inventory.filter((row) => row.scrollContainer).map((row) => row.file),
    mobileSheetFiles: inventory.filter((row) => row.mobileSheet).map((row) => row.file),
  }
  assert.ok(summary.sharedPrimitiveFiles.includes('src/components/StoreTransferPage.jsx'))
  assert.ok(summary.explicitDialogFiles.includes('src/components/PosPage.jsx'))
  assert.ok(summary.independentScrollFiles.includes('src/components/OrderRecordsPage.jsx'))
  process.stdout.write(`OVERLAY_INVENTORY=${JSON.stringify(summary)}\n`)
})
