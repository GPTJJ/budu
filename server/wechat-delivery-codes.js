/**
 * Single authority for the WeChat **delivery_id** used by the 发货信息管理
 * (upload_shipping_info) interface.
 *
 * Why this file exists and why it is separate from trace_waybill:
 *   WeChat publishes a DIFFERENT id space per product line. The 微信物流服务
 *   「传运单」page maps 韵达 to `YUNDA`, while the authoritative 运力id列表 used
 *   by upload_shipping_info (`get_delivery_list`) returns `YD` for 韵达速递.
 *   Reusing one set of codes for both interfaces silently mis-attributes the
 *   waybill, so the two consumers each own their list. Do NOT import the
 *   trace_waybill codes here, and do NOT import these codes into trace_waybill.
 *
 * Evidence (not memory). Every entry below was read off WeChat's own
 * `get_delivery_list` response — `POST cgi-bin/express/delivery/open_msg/
 * get_delivery_list`, fetched read-only on 2026-09-24 against the production
 * MiniProgram (TOTAL=1509 rows). Each row's `delivery_name` is quoted verbatim
 * so a reviewer can re-run the fetch and diff. Matching was EXACT on the
 * official name; the first column is only BUDU's own merchant-page code and is
 * never sent to WeChat.
 *
 *   顺丰速运 SF   中通快递 ZTO   圆通速递 YTO   韵达速递 YD
 *   申通快递 STO  京东快递 JD    EMS EMS
 *
 * 韵达 is the important one: BUDU's picker says `YUNDA`, WeChat wants `YD`.
 *
 * Unknown carrier ⇒ null, and callers MUST fail closed. WeChat has 1509 ids and
 * several near-identical names (e.g. `EMS` / `EMS2`「EMS国内」/ `CHINAEMS`,
 * `NSF`「新顺丰」/ `SF`「顺丰速运」/ `SFB2C`「顺丰国际」); guessing among them would
 * mis-attribute a real customer's parcel.
 */

/**
 * BUDU merchant-page carrier code → WeChat delivery_id.
 * `officialName` is the exact `delivery_name` returned by get_delivery_list.
 */
export const SHIPPING_DELIVERY_CODES = Object.freeze({
  SF: Object.freeze({ deliveryId: 'SF', officialName: '顺丰速运' }),
  ZTO: Object.freeze({ deliveryId: 'ZTO', officialName: '中通快递' }),
  YTO: Object.freeze({ deliveryId: 'YTO', officialName: '圆通速递' }),
  YUNDA: Object.freeze({ deliveryId: 'YD', officialName: '韵达速递' }),
  STO: Object.freeze({ deliveryId: 'STO', officialName: '申通快递' }),
  JD: Object.freeze({ deliveryId: 'JD', officialName: '京东快递' }),
  EMS: Object.freeze({ deliveryId: 'EMS', officialName: 'EMS' }),
})

/**
 * Carriers whose `delivery_id` we could NOT pin to a single official entry.
 * Kept explicit so a reviewer sees the gap rather than an invented value.
 *
 *   EMS2「EMS国内」 — a second EMS entry exists. We send `EMS`, whose official
 *   name is exactly "EMS" and which the 微信物流服务 industry page ties to
 *   中国邮政速递物流. `EMS2` is recorded here as the known sibling, not used.
 */
export const AMBIGUOUS_SHIPPING_DELIVERY_CODES = Object.freeze({
  EMS: Object.freeze(['EMS', 'EMS2']),
})

/** @returns {{deliveryId:string, officialName:string}|null} null ⇒ fail closed */
export function resolveShippingDeliveryId(carrierCode) {
  if (typeof carrierCode !== 'string') return null
  const entry = SHIPPING_DELIVERY_CODES[carrierCode.trim()]
  return entry ? { ...entry } : null
}

/** True when this carrier's id requires `contact` in shipping_list. */
export function shippingCarrierRequiresContact(deliveryId) {
  // WeChat: "当发货的物流公司为顺丰时，联系方式为必填，收件人或寄件人联系方式二选一".
  return deliveryId === 'SF'
}
