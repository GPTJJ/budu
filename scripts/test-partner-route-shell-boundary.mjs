import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('Partner route selects an isolated shell before the internal AuthenticatedApp', () => {
  const app = read('src/App.jsx')
  const partnerGuard = app.indexOf("pathname === '/partner'")
  const internalShell = app.indexOf('return <><OverlayStackManager /><AuthenticatedApp /></>')
  assert.ok(partnerGuard >= 0 && partnerGuard < internalShell)
  assert.match(app, /PartnerAccessPage/)
})

test('Partner shell uses only the Partner auth boundary and contains no internal Dashboard navigation', () => {
  const shell = read('src/components/PartnerAccessPage.jsx')
  assert.match(shell, /\/api\/partner/)
  assert.match(shell, /\/auth\/login/)
  assert.match(shell, /\/auth\/me/)
  assert.match(shell, /\/auth\/logout/)
  assert.doesNotMatch(shell, /Dashboard|Sidebar|\/api\/auth|\/api\/v2/)
  assert.match(shell, /我要补货/)
  assert.match(shell, /补货订单/)
  assert.match(shell, /合作伙伴中心导航/)
  assert.match(shell, /safe-area-inset-top/)
  assert.match(shell, /safe-area-inset-bottom/)
  assert.match(shell, /overflow-x-hidden/)
})

test('generic internal account administration cannot target external Partner users', () => {
  const app = read('server/app.js')
  assert.match(app, /users\.filter\(isInternalUser\)/)
  assert.equal((app.match(/findInternalUser\(users, req\.params\.id\)/g) || []).length, 6)
  assert.doesNotMatch(app, /users\.find\(\(u\) => u\.id === req\.params\.id\)/)
})
