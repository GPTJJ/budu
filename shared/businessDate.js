export const BUDU_BUSINESS_TIME_ZONE = 'Asia/Shanghai'

/** Resolve a BUDU business date from an authoritative server instant. */
export function buduBusinessDate(value = new Date()) {
  const instant = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(instant.getTime())) throw new TypeError('business date instant is invalid')
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUDU_BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant)
  const get = (type) => parts.find((part) => part.type === type)?.value || ''
  return `${get('year')}-${get('month')}-${get('day')}`
}
