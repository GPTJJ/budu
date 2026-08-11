import { lazy } from 'react'

/** 懒加载分包失败时自动重试，避免弱网/发版瞬间“页面加载出错” */
export function lazyRetry(loader, retries = 2) {
  const attempt = async (left) => {
    try {
      return await loader()
    } catch (error) {
      if (left <= 0) throw error
      await new Promise((resolve) => setTimeout(resolve, 600))
      return attempt(left - 1)
    }
  }
  return lazy(() => attempt(retries))
}
