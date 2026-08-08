import { Component } from 'react'

/**
 * 全局错误边界：捕获渲染/懒加载分片错误，避免白屏。
 * 分片加载失败（发版后旧文件 404）时自动刷新一次；其余错误显示可重试页面。
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error) {
    console.error('[ErrorBoundary]', error)
    const msg = String((error && error.message) || error || '')
    const isChunk = /ChunkLoadError|Loading chunk|Failed to fetch dynamically imported module/i.test(msg)
    if (isChunk && typeof sessionStorage !== 'undefined') {
      const key = 'budu-er-reload'
      if (!sessionStorage.getItem(key)) {
        sessionStorage.setItem(key, '1')
        setTimeout(() => window.location.reload(), 300)
      }
    }
  }

  handleReload = () => {
    try {
      if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem('budu-er-reload')
    } catch {
      /* 忽略 */
    }
    window.location.reload()
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="grid min-h-[70vh] place-items-center px-4">
        <div className="card w-full max-w-md p-8 text-center" role="alert">
          <p className="text-4xl">😵</p>
          <h2 className="mt-4 text-lg font-bold text-slate-800">页面加载出错了</h2>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            可能是刚发布了新版本或网络波动，刷新一次即可恢复。
          </p>
          <button
            onClick={this.handleReload}
            className="btn-primary mt-6 px-6 py-2.5"
          >
            刷新页面
          </button>
        </div>
      </div>
    )
  }
}
