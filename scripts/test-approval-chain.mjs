import assert from 'node:assert/strict'
import { resolveApprovalChain, APPROVAL_CHAIN, isApproverFor } from '../server/approvals-core.js'

const cases = []
const check = (name, fn) => { try { fn(); cases.push(['PASS', name]) } catch (e) { cases.push(['FAIL', `${name}: ${e.message}`]) } }

check('默认链顺序为 胡东辉 → 杨梦彤', () => assert.deepEqual(APPROVAL_CHAIN, ['budu', '杨梦彤']))
check('普通员工提交：两级都要审', () => assert.deepEqual(resolveApprovalChain('白婷'), ['budu', '杨梦彤']))
check('胡东辉本人提交：跳过他，只剩杨梦彤', () => assert.deepEqual(resolveApprovalChain('budu'), ['杨梦彤']))
check('杨梦彤本人提交：跳过他，只剩胡东辉', () => assert.deepEqual(resolveApprovalChain('杨梦彤'), ['budu']))
check('金晶提交：两级都要审', () => assert.deepEqual(resolveApprovalChain('金晶'), ['budu', '杨梦彤']))
check('steps 规则下审批人身份识别', () => {
  const template = { approverRule: { type: 'steps', steps: [{ username: 'budu' }, { username: '杨梦彤' }] } }
  const request = { status: 'pending', submitterUsername: '白婷' }
  assert.equal(isApproverFor({ username: 'budu', role: 'developer' }, request, template), true)
  assert.equal(isApproverFor({ username: '杨梦彤', role: 'admin' }, request, template), true)
  assert.equal(isApproverFor({ username: '白婷', role: 'staff' }, request, template), false)
})

let pass = 0
for (const [state, msg] of cases) { console.log(`  [${state}] ${msg}`); if (state === 'PASS') pass += 1 }
console.log(`结果: ${pass} 通过 / ${cases.length - pass} 失败`)
process.exit(pass === cases.length ? 0 : 1)
