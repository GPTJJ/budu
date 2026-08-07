import { createApp } from './app.js'
import { meituanConfig } from './meituan/config.js'
import { runMeituanSync } from './meituan/sync.js'

const PORT = Number(process.env.PORT || 3000)
createApp().listen(PORT, '0.0.0.0', () => {
  console.log(`BUDU server: http://localhost:${PORT}`)
  console.log(`局域网访问: http://<本机IP>:${PORT}（可用 ipconfig 查看）`)

  const mt = meituanConfig()
  if (mt.enabled) {
    setTimeout(() => runMeituanSync().catch((e) => console.error('[meituan]', e.message)), 3000)
    setInterval(() => runMeituanSync().catch((e) => console.error('[meituan]', e.message)), mt.pollMs)
    console.log(`美团同步已启用：每 ${mt.pollMs / 60000} 分钟轮询`)
  }
})
