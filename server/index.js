import { createApp } from './app.js'

const PORT = Number(process.env.PORT || 3000)
createApp().listen(PORT, '0.0.0.0', () => {
  console.log(`BUDU server: http://localhost:${PORT}`)
  console.log(`局域网访问: http://<本机IP>:${PORT}（可用 ipconfig 查看）`)
})
