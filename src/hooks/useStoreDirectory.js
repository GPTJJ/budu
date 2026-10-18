import { useEffect, useMemo, useReducer } from 'react'
import { allStores } from '../utils/selectors'
import { onUserDataUpdated } from '../utils/userData'

/** Complete historical directory; state updates do not remount the business form. */
export default function useStoreDirectory() {
  const [revision, refresh] = useReducer((value) => value + 1, 0)
  useEffect(() => onUserDataUpdated(refresh), [])
  return useMemo(() => allStores(), [revision])
}
