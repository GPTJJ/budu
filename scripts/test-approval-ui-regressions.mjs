import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const read = (file) => readFileSync(resolve(root, file), 'utf8')

test('工资审批成功反馈先播放动画，再离开提交页', () => {
  const source = read('src/components/approval/ApprovalFormView.jsx')
  assert.match(source, /import \{ t \} from '\.\.\/\.\.\/utils\/text'/)
  assert.match(source, /<BuduSuccessFeedback/)
  assert.match(source, /open=\{Boolean\(feedback\)\}/)
  assert.match(source, /onClose=\{\(\) => \{[\s\S]*onSaved\?\.\(request, true\)/)

  const saveStart = source.indexOf('const save = async (submit) =>')
  const successStart = source.indexOf('if (submit) {', saveStart)
  const successEnd = source.indexOf('} catch (e) {', successStart)
  const successBranch = source.slice(successStart, successEnd)
  assert.match(successBranch, /setFeedback\(/)
  assert.doesNotMatch(successBranch, /setFeedback\([\s\S]*onSaved\?\.\([^\n]+true\)/)
})

test('通知面板通过 body portal 脱离 Header 层叠上下文', () => {
  const source = read('src/components/NotificationBell.jsx')
  assert.match(source, /import \{ createPortal \} from 'react-dom'/)
  assert.match(source, /open && createPortal\(/)
  assert.match(source, /document\.body/)
  assert.match(source, /z-\[130\]/)
  assert.match(source, /max-h-\[calc\(100dvh/)
})
