// 一键公网分享：启动本地服务 + 公网隧道，自动打印网址。
// 优先级：cpolar（固定域名，已配置时）> serveo（免费随机域名）
// 用法: node scripts/start-public.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const CPOLAR = path.join(ROOT, 'tools', 'cpolar-portable', 'cpolar', 'cpolar.exe')
const CPOLAR_CFG = path.join(ROOT, 'tools', 'cpolar-budu.yml')

function cpolarReady() {
  try {
    if (!fs.existsSync(CPOLAR) || !fs.existsSync(CPOLAR_CFG)) return false
    const cfg = fs.readFileSync(CPOLAR_CFG, 'utf8')
    return cfg.includes('authtoken:') && !cfg.includes('在这里填入') && cfg.includes('tunnels:')
  } catch {
    return false
  }
}

const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { stdio: 'inherit' })

function shutdown() {
  server.kill()
  if (tunnel) tunnel.kill()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

let tunnel = null

if (cpolarReady()) {
  const cfg = fs.readFileSync(CPOLAR_CFG, 'utf8')
  const m = cfg.match(/domain:\s*([^\s]+)/)
  tunnel = spawn(CPOLAR, ['--config', CPOLAR_CFG, 'start', 'budu'], { stdio: 'inherit' })
  if (m) {
    console.log('\n✅ 固定域名（cpolar）: https://' + m[1])
    console.log('   发送给同事即可；首次访问如有提示页，点「继续访问」进入登录页。\n')
  }
} else {
  tunnel = spawn('ssh', [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ServerAliveInterval=30',
    '-R', '80:localhost:3000',
    'serveo.net',
  ], { stdio: ['ignore', 'pipe', 'inherit'] })
  tunnel.stdout.on('data', (chunk) => {
    const text = chunk.toString()
    process.stdout.write(text)
    const m = text.match(/https:\/\/[a-z0-9-]+\.serveousercontent\.com/)
    if (m && !globalThis.__urlPrinted) {
      globalThis.__urlPrinted = true
      console.log('\n✅ 公网网址（临时，重启会变化）: ' + m[0])
      console.log('   同事首次访问会看到 serveo 提示页，点「Continue / 继续访问」即可进入登录页。')
      console.log('   想用固定域名？注册 cpolar 后填写 tools/cpolar-budu.yml（见文件内注释）。\n')
    }
  })
}