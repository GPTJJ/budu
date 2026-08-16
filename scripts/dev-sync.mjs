#!/usr/bin/env node
/**
 * 双机开发同步脚本（Mac / Windows 通用，依赖 Node）。
 * 用法：
 *   node scripts/dev-sync.mjs status   查看与 GitHub 的差异
 *   node scripts/dev-sync.mjs pull     拉取最新（rebase）并提示是否需要 npm install
 *   node scripts/dev-sync.mjs push [信息]  提交全部改动并推送；未给信息时使用默认文案
 */
import { execSync, spawnSync } from 'node:child_process'

const action = process.argv[2] || 'status'
const message = process.argv.slice(3).join(' ') || 'chore: WIP'

function run(cmd, opts = {}) {
  const res = spawnSync(cmd, { shell: true, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts })
  return res
}

function fail(cmd) {
  console.error(`[dev-sync] 命令失败：${cmd}`)
  console.error(cmd.stderr?.trim())
  process.exit(1)
}

const lockBefore = (() => {
  try { return execSync('git rev-parse HEAD:package-lock.json', { encoding: 'utf8' }).trim() } catch { return '' }
})()

run('git fetch origin main')

if (action === 'pull') {
  const r = run('git rebase origin/main')
  if (r.status !== 0) {
    console.error('[dev-sync] rebase 失败，可能存在冲突，请手动处理后再运行。')
    process.exit(1)
  }
  const lockAfter = (() => {
    try { return execSync('git rev-parse HEAD:package-lock.json', { encoding: 'utf8' }).trim() } catch { return '' }
  })()
  if (lockBefore !== lockAfter) {
    console.log('[dev-sync] package-lock.json 已变化，建议执行 npm install。')
  }
  console.log('[dev-sync] pull 完成。')
  process.exit(0)
}

if (action === 'push') {
  const status = execSync('git status --porcelain', { encoding: 'utf8' }).trim()
  if (!status) {
    console.log('[dev-sync] 没有可提交的改动。')
  } else {
    run('git add -A')
    const c = run(`git commit -m "${message.replace(/"/g, '\\"')}"`)
    if (c.status !== 0) {
      console.error('[dev-sync] commit 失败（可能没有改动或需要合并）。')
      process.exit(1)
    }
  }
  const rb = run('git pull --rebase origin main')
  if (rb.status !== 0) {
    console.error('[dev-sync] rebase 失败，请手动解决冲突后重新 push。')
    process.exit(1)
  }
  const p = run('git push origin main')
  if (p.status !== 0) fail('git push origin main')
  console.log('[dev-sync] push 完成。')
  process.exit(0)
}

// status（默认）
const status = execSync('git status --short', { encoding: 'utf8' }).trim()
const branch = execSync('git branch --show-current', { encoding: 'utf8' }).trim()
let aheadBehind = ''
try {
  aheadBehind = execSync('git rev-list --left-right --count origin/main...HEAD', { encoding: 'utf8' }).trim()
} catch { /* 忽略 */ }
console.log(`[dev-sync] branch=${branch} (behind ahead)=${aheadBehind}`)
console.log(status || '[dev-sync] 工作区干净')
