import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (path) => fs.readFileSync(path, 'utf8')

test('budu-sweet-card skill is discoverable and routed for Sweet Card intents', () => {
  const skill = read('.agents/skills/budu-sweet-card/SKILL.md')
  const contract = read('.agents/skills/budu-sweet-card/references/business-contract.md')
  const router = read('.agents/skills/budu-task-router/SKILL.md')
  const agents = read('AGENTS.md')

  assert.match(skill, /^---\nname: budu-sweet-card\n/m)
  assert.match(skill, /budu 甜意卡/)
  assert.match(skill, /budu-payment-safety/)
  assert.match(skill, /production feature flag defaults OFF/i)
  assert.match(contract, /Value account owns/)
  assert.match(contract, /ProductCategory\.id/)
  assert.match(contract, /recipientLabel.*never prove customer identity/i)
  assert.match(contract, /one Sweet Card/i)
  assert.match(contract, /refund allocation/i)
  for (const intent of ['甜意卡', '礼品卡', '商务赠卡', '核销', '余额', '绑定', '挂失', '补发']) assert.match(router, new RegExp(intent))
  assert.match(agents, /budu-sweet-card/)
})
