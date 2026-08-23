// 终端 IP 严格校验（R3）：唯一权威规则，供 配置层（wechat-config.js）与
// Provider 边界（wechat-pay.js）共用，禁止两处维护微妙不同的逻辑。
//
// 规则：只接受可用于 spbill_create_ip 的「公网可路由 IPv4」。
// 拒绝：格式非法（含 IPv6/localhost/空值）、IANA 保留/特殊用途/不可路由地址。
// 绝不对非法值做任何归一化回退（例如 127.0.0.1）。

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

// IANA IPv4 特殊用途/保留/不可路由段（含 RFC1918、回环、链路本地、CGNAT、
// 文档 TEST-NET、基准测试、组播、保留 240/4 与广播）。以 [start, end] 32 位
// 大端数值表示（含端点）。任何落入这些区间的地址一律拒绝。
export const RESERVED_IPV4_RANGES = [
  [0x00000000, 0x00ffffff], // 0.0.0.0/8           "This network"
  [0x0a000000, 0x0affffff], // 10.0.0.0/8          RFC1918 私网
  [0x64400000, 0x647fffff], // 100.64.0.0/10       CGNAT 共享地址空间
  [0x7f000000, 0x7fffffff], // 127.0.0.0/8         回环
  [0xa9fe0000, 0xa9feffff], // 169.254.0.0/16      链路本地
  [0xac100000, 0xac1fffff], // 172.16.0.0/12       RFC1918 私网
  [0xc0000000, 0xc00000ff], // 192.0.0.0/24        IETF 协议分配
  [0xc0000200, 0xc00002ff], // 192.0.2.0/24        TEST-NET-1 文档
  [0xc0586300, 0xc05863ff], // 192.88.99.0/24      已弃用 6to4 中继任播
  [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16      RFC1918 私网
  [0xc6120000, 0xc613ffff], // 198.18.0.0/15       基准测试
  [0xc6336400, 0xc63364ff], // 198.51.100.0/24     TEST-NET-2 文档
  [0xcb007100, 0xcb0071ff], // 203.0.113.0/24      TEST-NET-3 文档
  [0xe0000000, 0xefffffff], // 224.0.0.0/4         组播
  [0xf0000000, 0xffffffff], // 240.0.0.0/4         保留（含 255.255.255.255 广播）
]

/**
 * 是否为可用于 spbill_create_ip 的公网可路由 IPv4。
 * 输入：任意值；空值/非字符串/IPv6/localhost/畸形/保留段 → false。
 */
export function isValidPublicIpv4(value) {
  const text = String(value ?? '').trim()
  if (!IPV4_RE.test(text)) return false
  let num = 0
  for (const part of text.split('.')) num = (num << 8) | Number(part)
  num >>>= 0
  return !RESERVED_IPV4_RANGES.some(([start, end]) => num >= start && num <= end)
}
