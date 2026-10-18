import { useEffect, useReducer } from 'react'
import { operatingStores } from '../utils/selectors'
import { onUserDataUpdated } from '../utils/userData'

/** 在权威目录刷新后更新已打开的选择器；不清除表单或 POS 草稿。 */
export default function useOperatingStores() {
  const [, refresh] = useReducer((value) => value + 1, 0)
  useEffect(() => onUserDataUpdated(refresh), [])
  return operatingStores()
}
