// 用户已确认的业务闭店日，仅用于经营视图/缺录提示的历史期间判断。
// 实际新业务办理仍只由服务端 Store.active 决定，不按回填日期放行。
import { CHAOWAI_BUSINESS_CLOSED_ON, storeOperatedInPeriod } from '../../shared/storeOperationDates.js'
export { CHAOWAI_BUSINESS_CLOSED_ON }

export function storeVisibleInOperatingPeriod(store, firstDate, lastDate = firstDate) {
  return storeOperatedInPeriod(store, firstDate, lastDate)
}
