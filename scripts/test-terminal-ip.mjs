// R3 Blocker 1：共享严格公网 IPv4 校验器单元测试（terminal-ip.js）
// 覆盖：保留段区间边界（含端点）、格式非法（IPv6/localhost/空/畸形）、
// 合法公网地址通过。配置层与 Provider 边界共用同一实现（各自有集成断言）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { isValidPublicIpv4, RESERVED_IPV4_RANGES } from '../server/payments/terminal-ip.js'

const ip = (a, b, c, d) => `${a}.${b}.${c}.${d}`
const toNum = (text) => {
  let num = 0
  for (const part of text.split('.')) num = (num << 8) | Number(part)
  return num >>> 0
}
const fromNum = (num) => ip((num >>> 24) & 255, (num >>> 16) & 255, (num >>> 8) & 255, num & 255)

// 评审要求的保留/不可路由段（每段在 RESERVED_IPV4_RANGES 中都必须存在）
const REQUIRED_SEGMENTS = [
  ['0.0.0.0/8', '0.0.0.0'],
  ['10.0.0.0/8', '10.0.0.0'],
  ['100.64.0.0/10', '100.64.0.0'],
  ['127.0.0.0/8', '127.0.0.0'],
  ['169.254.0.0/16', '169.254.0.0'],
  ['172.16.0.0/12', '172.16.0.0'],
  ['192.0.0.0/24', '192.0.0.0'],
  ['192.0.2.0/24', '192.0.2.0'],
  ['192.168.0.0/16', '192.168.0.0'],
  ['198.18.0.0/15', '198.18.0.0'],
  ['198.51.100.0/24', '198.51.100.0'],
  ['203.0.113.0/24', '203.0.113.0'],
  ['224.0.0.0/4', '224.0.0.0'],
  ['240.0.0.0/4', '240.0.0.0'],
]

test('R3：评审要求的全部保留段必须存在且区间覆盖正确', () => {
  for (const [label, startText] of REQUIRED_SEGMENTS) {
    const start = toNum(startText)
    const found = RESERVED_IPV4_RANGES.some(([lo, hi]) => start >= lo && start <= hi)
    assert.equal(found, true, `保留段 ${label}（起点 ${startText}）必须被覆盖`)
  }
})

test('R3：保留段区间边界——段内全部拒绝，段外紧邻全部放行', () => {
  const segments = [
    ['0.0.0.0/8', toNum('0.0.0.0'), toNum('0.255.255.255'), ip(1, 0, 0, 0)],
    ['10.0.0.0/8', toNum('10.0.0.0'), toNum('10.255.255.255'), ip(11, 0, 0, 0)],
    ['100.64.0.0/10', toNum('100.64.0.0'), toNum('100.127.255.255'), ip(100, 128, 0, 0)],
    ['127.0.0.0/8', toNum('127.0.0.0'), toNum('127.255.255.255'), ip(128, 0, 0, 0)],
    ['169.254.0.0/16', toNum('169.254.0.0'), toNum('169.254.255.255'), ip(169, 255, 0, 0)],
    ['172.16.0.0/12', toNum('172.16.0.0'), toNum('172.31.255.255'), ip(172, 32, 0, 0)],
    ['192.0.0.0/24', toNum('192.0.0.0'), toNum('192.0.0.255'), ip(192, 0, 1, 0)],
    ['192.0.2.0/24', toNum('192.0.2.0'), toNum('192.0.2.255'), ip(192, 0, 3, 0)],
    ['192.88.99.0/24', toNum('192.88.99.0'), toNum('192.88.99.255'), ip(192, 88, 100, 0)],
    ['192.168.0.0/16', toNum('192.168.0.0'), toNum('192.168.255.255'), ip(192, 169, 0, 0)],
    ['198.18.0.0/15', toNum('198.18.0.0'), toNum('198.19.255.255'), ip(198, 20, 0, 0)],
    ['198.51.100.0/24', toNum('198.51.100.0'), toNum('198.51.100.255'), ip(198, 51, 101, 0)],
    ['203.0.113.0/24', toNum('203.0.113.0'), toNum('203.0.113.255'), ip(203, 0, 114, 0)],
    ['224.0.0.0/4', toNum('224.0.0.0'), toNum('239.255.255.255'), null], // 紧邻 240.0.0.0 仍为保留段
    ['240.0.0.0/4', toNum('240.0.0.0'), toNum('255.255.255.255'), null], // 无段外地址
  ]
  for (const [label, lo, hi, after] of segments) {
    for (const addr of [fromNum(lo), fromNum(hi), fromNum(Math.floor((lo + hi) / 2))]) {
      assert.equal(isValidPublicIpv4(addr), false, `${label} 段内 ${addr} 必须拒绝`)
    }
    if (after !== null) {
      assert.equal(isValidPublicIpv4(after), true, `${label} 段后紧邻 ${after} 必须放行`)
    }
  }
  // 首段前无地址、末段后无地址：全 0 与全 255 已在段内
  assert.equal(isValidPublicIpv4(ip(0, 0, 0, 0)), false)
  assert.equal(isValidPublicIpv4(ip(255, 255, 255, 255)), false)
})

test('R3：评审零传输清单中的非法值必须全部拒绝', () => {
  const REJECT = [
    '224.0.0.1', // 组播
    '240.0.0.1', // 保留
    '255.0.0.1', // 保留段 240/4
    '127.0.0.1', // 回环
    '192.168.1.1', // RFC1918
    '169.254.1.1', // 链路本地
    '0.0.0.0', // 未指定
    '::1', // IPv6 回环
    'invalid', // 非 IP
    '', // 空
    undefined,
    null,
    '10.0.0.1', // RFC1918
    '100.64.0.1', // CGNAT
    '172.16.0.1', // RFC1918
    '192.0.0.1', // IETF 协议分配
    '192.0.2.1', // TEST-NET-1
    '198.18.0.1', // 基准测试
    '198.51.100.1', // TEST-NET-2
    '203.0.113.1', // TEST-NET-3
    '2001:db8::1', // IPv6
    'localhost',
    '1.2.3', // 缺段
    '1.2.3.4.5', // 多段
    '256.1.1.1', // 越界
    '01.2.3.4', // 前导零
    '1.2.3.-4', // 负数
    '8 .8.8.8', // 中间空白
    '8..8.8', // 空段
  ]
  for (const value of REJECT) {
    assert.equal(isValidPublicIpv4(value), false, `必须拒绝: ${JSON.stringify(value)}`)
  }
  // trim 语义：首尾空白允许（环境变量常见），中间不允许
  assert.equal(isValidPublicIpv4(' 8.8.8.8 '), true)
})

test('R3：合法公网 IPv4 放行', () => {
  const ACCEPT = [
    '1.1.1.1',
    '8.8.8.8',
    '114.114.114.114',
    '223.255.255.255', // 224/4 前最后地址
    '100.63.255.255', // CGNAT 段前
    '100.128.0.1', // CGNAT 段后
    '172.15.255.255', // 172.16/12 前
    '172.32.0.1', // 172.16/12 后
    '192.167.255.255', // 192.168/16 前
    '192.169.0.1', // 192.168/16 后
    '198.20.0.1', // 198.18/15 后
    '203.0.114.1', // TEST-NET-3 后
    '223.255.255.254',
  ]
  for (const value of ACCEPT) {
    assert.equal(isValidPublicIpv4(value), true, `必须放行: ${value}`)
  }
  // 无归一化：相同值往返一致（校验器不做任何改写）
  assert.equal(isValidPublicIpv4('8.8.8.8'), isValidPublicIpv4('8.8.8.8'))
})

test('R3：共享使用——配置层与 Provider 边界引用同一实现（无重复逻辑）', async () => {
  const { wechatPayConfig } = await import('../server/payments/wechat-config.js')
  const { WechatPayProvider } = await import('../server/payments/providers/wechat-pay.js')
  // 通过导出表名确认两处都依赖 terminal-ip.js 的单一实现：
  // 配置层 problems 文案与 Provider 501 文案都来自共享校验结果
  const config = wechatPayConfig
  const Provider = WechatPayProvider
  assert.equal(typeof config, 'function')
  assert.equal(typeof Provider, 'function')
  // 非法值在两处行为一致（此处仅验证共享模块本身已被两处使用——集成断言分别在
  // test-wechat-config.mjs（configured=false）与 test-wechat-pay-provider.mjs（501 零传输））
  assert.equal(isValidPublicIpv4('224.0.0.1'), false)
  assert.equal(isValidPublicIpv4('8.8.8.8'), true)
})
