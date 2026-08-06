import express from 'express'
import cookieParser from 'cookie-parser'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { loadDb, persist } from './store.js'
import { hashPassword, verifyPassword, signToken, verifyToken } from './auth.js'
import { parseAnalysis } from './analysis.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const DIST = path.join(ROOT, 'dist')
const COOKIE = 'budu_token'
const COOKIE_MAX_AGE = 30 * 24 * 3600 * 1000

export function createApp() {
  const app = express()
  app.use(express.json({ limit: '5mb' }))
  app.use(cookieParser())

  async function getSecret() {
    return process.env.JWT_SECRET || (await loadDb()).meta.secret
  }

  function userPublic(u) {
    return { id: u.id, username: u.username, role: u.role, avatar: u.avatar || '', createdAt: u.createdAt }
  }

  function setAuthCookie(res, token) {
    res.cookie(COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: COOKIE_MAX_AGE,
      secure: process.env.COOKIE_SECURE === '1',
    })
  }

  async function requireAuth(req, res, next) {
    const token = req.cookies[COOKIE]
    const payload = token ? verifyToken(token, await getSecret()) : null
    if (!payload || !payload.sub) return res.status(401).json({ error: '未登录或登录已过期' })
    const user = (await loadDb()).users.find((u) => u.id === payload.sub)
    if (!user) return res.status(401).json({ error: '账号不存在' })
    req.user = user
    next()
  }

  function requireDeveloper(req, res, next) {
    if (!req.user || req.user.role !== 'developer') {
      return res.status(403).json({ error: '无权限' })
    }
    next()
  }

  function requireOperational(req, res, next) {
    if (!req.user || req.user.role === 'public') {
      return res.status(403).json({ error: '无权限' })
    }
    next()
  }

  app.get('/api/health', (req, res) => res.json({ ok: true, time: Date.now() }))

  // ---------- 注册（第一个用户自动成为管理员） ----------
  app.post('/api/auth/register', async (req, res) => {
    const username = String(req.body.username || '').trim()
    const password = String(req.body.password || '')
    if (username.length < 2 || username.length > 20) return res.status(400).json({ error: '用户名需为 2-20 个字符' })
    if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' })
    const db = await loadDb()
    if (db.users.some((u) => u.username === username)) return res.status(409).json({ error: '用户名已存在' })
    const user = {
      id: crypto.randomUUID(),
      username,
      role: db.users.length === 0 ? 'developer' : 'store',
      passwordHash: hashPassword(password),
      createdAt: new Date().toISOString(),
    }
    db.users.push(user)
    await persist()
    setAuthCookie(res, signToken(user, await getSecret()))
    res.json({ user: userPublic(user) })
  })

  // ---------- 登录 ----------
  app.post('/api/auth/login', async (req, res) => {
    const username = String(req.body.username || '').trim()
    const password = String(req.body.password || '')
    const user = (await loadDb()).users.find((u) => u.username === username)
    if (!user || !verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ error: '用户名或密码错误' })
    }
    setAuthCookie(res, signToken(user, await getSecret()))
    res.json({ user: userPublic(user) })
  })

  // ---------- 退出 ----------
  app.post('/api/auth/logout', (req, res) => {
    res.clearCookie(COOKIE)
    res.json({ ok: true })
  })

  // ---------- 当前登录用户 ----------
  app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ user: userPublic(req.user) })
  })

  // ---------- 修改用户名 / 头像 / 密码（复用 /api/auth/me，兼容 Vercel 已有函数） ----------
  app.put('/api/auth/me', requireAuth, async (req, res) => {
    const body = req.body || {}
    if (body.oldPassword !== undefined || body.newPassword !== undefined) {
      const oldPassword = String(body.oldPassword || '')
      const newPassword = String(body.newPassword || '')
      if (!verifyPassword(oldPassword, req.user.passwordHash)) {
        return res.status(400).json({ error: '当前密码错误' })
      }
      if (newPassword.length < 6) {
        return res.status(400).json({ error: '密码至少 6 位' })
      }
      req.user.passwordHash = hashPassword(newPassword)
      await persist()
      return res.json({ ok: true })
    }
    const db = await loadDb()
    if (body.username !== undefined) {
      const username = String(body.username || '').trim()
      if (username.length < 2 || username.length > 20) {
        return res.status(400).json({ error: '用户名需为 2-20 个字符' })
      }
      if (db.users.some((u) => u.id !== req.user.id && u.username === username)) {
        return res.status(409).json({ error: '用户名已存在' })
      }
      req.user.username = username
    }
    if (body.avatar !== undefined) {
      const avatar = typeof body.avatar === 'string' ? body.avatar.trim() : ''
      if (avatar && !avatar.startsWith('data:image/')) {
        return res.status(400).json({ error: '头像格式错误' })
      }
      if (avatar.length > 500000) {
        return res.status(400).json({ error: '头像文件过大' })
      }
      req.user.avatar = avatar
    }
    await persist()
    res.json({ user: userPublic(req.user) })
  })

  // ---------- 修改用户名 / 头像 ----------
  app.put('/api/auth/profile', requireAuth, async (req, res) => {
    const body = req.body || {}
    const db = await loadDb()
    if (body.username !== undefined) {
      const username = String(body.username || '').trim()
      if (username.length < 2 || username.length > 20) {
        return res.status(400).json({ error: '用户名需为 2-20 个字符' })
      }
      if (db.users.some((u) => u.id !== req.user.id && u.username === username)) {
        return res.status(409).json({ error: '用户名已存在' })
      }
      req.user.username = username
    }
    if (body.avatar !== undefined) {
      const avatar = typeof body.avatar === 'string' ? body.avatar.trim() : ''
      if (avatar && !avatar.startsWith('data:image/')) {
        return res.status(400).json({ error: '头像格式错误' })
      }
      if (avatar.length > 500000) {
        return res.status(400).json({ error: '头像文件过大' })
      }
      req.user.avatar = avatar
    }
    await persist()
    res.json({ user: userPublic(req.user) })
  })

  // ---------- 修改密码 ----------
  app.put('/api/auth/password', requireAuth, async (req, res) => {
    const oldPassword = String(req.body.oldPassword || '')
    const newPassword = String(req.body.newPassword || '')
    if (!verifyPassword(oldPassword, req.user.passwordHash)) {
      return res.status(400).json({ error: '当前密码错误' })
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: '密码至少 6 位' })
    }
    req.user.passwordHash = hashPassword(newPassword)
    await persist()
    res.json({ ok: true })
  })

  // ---------- 账号管理（最高权限） ----------
  app.get('/api/admin/users', requireAuth, requireDeveloper, async (req, res) => {
    const db = await loadDb()
    res.json({ users: db.users.map(userPublic) })
  })

  app.put('/api/admin/users/:id/role', requireAuth, requireDeveloper, async (req, res) => {
    const role = String(req.body.role || '')
    if (!['developer', 'store', 'public'].includes(role)) {
      return res.status(400).json({ error: '角色不正确' })
    }
    const db = await loadDb()
    const target = db.users.find((u) => u.id === req.params.id)
    if (!target) return res.status(404).json({ error: '账号不存在' })
    if (target.id === req.user.id) {
      return res.status(400).json({ error: '不能修改自己的权限' })
    }
    const developerCount = db.users.filter((u) => u.role === 'developer').length
    if (target.role === 'developer' && role !== 'developer' && developerCount <= 1) {
      return res.status(400).json({ error: '至少保留一个最高权限账号' })
    }
    target.role = role
    await persist()
    res.json({ user: userPublic(target) })
  })

  app.put('/api/admin/users/:id/password', requireAuth, requireDeveloper, async (req, res) => {
    const newPassword = String(req.body.newPassword || '')
    if (newPassword.length < 6) {
      return res.status(400).json({ error: '密码至少 6 位' })
    }
    const db = await loadDb()
    const target = db.users.find((u) => u.id === req.params.id)
    if (!target) return res.status(404).json({ error: '账号不存在' })
    target.passwordHash = hashPassword(newPassword)
    await persist()
    res.json({ ok: true })
  })

  app.delete('/api/admin/users/:id', requireAuth, requireDeveloper, async (req, res) => {
    const db = await loadDb()
    const target = db.users.find((u) => u.id === req.params.id)
    if (!target) return res.status(404).json({ error: '账号不存在' })
    if (target.id === req.user.id) {
      return res.status(400).json({ error: '不能删除自己' })
    }
    const developerCount = db.users.filter((u) => u.role === 'developer').length
    if (target.role === 'developer' && developerCount <= 1) {
      return res.status(400).json({ error: '至少保留一个最高权限账号' })
    }
    db.users = db.users.filter((u) => u.id !== target.id)
    await persist()
    res.json({ ok: true })
  })

  // ---------- 共享数据：读取（业绩录入 + 员工名单，全团队共享） ----------
  app.get('/api/userdata', requireAuth, async (req, res) => {
    const db = await loadDb()
    res.json({
      entries: db.entries,
      staff: db.staff,
      removedStaff: db.removedStaff || [],
      analysis: db.analysis || {},
      productImages: db.productImages || {},
    })
  })

  // ---------- 共享数据：整体保存 ----------
  app.put('/api/userdata', requireAuth, async (req, res) => {
    const body = req.body || {}
    const db = await loadDb()
    if (body.entries !== undefined) {
      if (typeof body.entries !== 'object' || Array.isArray(body.entries)) {
        return res.status(400).json({ error: 'entries 格式错误' })
      }
      db.entries = body.entries
    }
    if (body.staff !== undefined) {
      const staffChanged = JSON.stringify(body.staff) !== JSON.stringify(db.staff || [])
      if (staffChanged && req.user.role !== 'developer') {
        return res.status(403).json({ error: '无权限' })
      }
      if (!Array.isArray(body.staff)) return res.status(400).json({ error: 'staff 格式错误' })
      db.staff = body.staff
    }
    if (body.removedStaff !== undefined) {
      const removedChanged = JSON.stringify(body.removedStaff) !== JSON.stringify(db.removedStaff || [])
      if (removedChanged && req.user.role !== 'developer') {
        return res.status(403).json({ error: '无权限' })
      }
      if (!Array.isArray(body.removedStaff) || body.removedStaff.some((n) => typeof n !== 'string')) {
        return res.status(400).json({ error: 'removedStaff 格式错误' })
      }
      db.removedStaff = body.removedStaff
    }
    if (body.productImages !== undefined) {
      if (typeof body.productImages !== 'object' || Array.isArray(body.productImages)) {
        return res.status(400).json({ error: 'productImages 格式错误' })
      }
      for (const [key, value] of Object.entries(body.productImages)) {
        if (key.length > 100 || typeof value !== 'string' || (value && !value.startsWith('data:image/'))) {
          return res.status(400).json({ error: '商品图片格式错误' })
        }
        if (value.length > 500000) {
          return res.status(400).json({ error: '商品图片过大' })
        }
      }
      db.productImages = body.productImages
    }
    await persist()
    res.json({
      ok: true,
      entries: db.entries,
      staff: db.staff,
      removedStaff: db.removedStaff || [],
      productImages: db.productImages || {},
    })
  })

  // ---------- 数据分析：上传报表并解析 ----------
  app.post('/api/analysis/upload', requireAuth, requireOperational, async (req, res) => {
    const body = req.body || {}
    const name = String(body.name || '')
    const raw = String(body.base64 || '').replace(/^data:[^;]+;base64,/, '')
    if (!raw) return res.status(400).json({ error: '请选择文件' })
    const buffer = Buffer.from(raw, 'base64')
    if (buffer.length > 10 * 1024 * 1024) {
      return res.status(400).json({ error: '文件过大（最大 10MB）' })
    }
    const parsed = parseAnalysis(buffer, name)
    if (!parsed) {
      return res.status(400).json({ error: '未识别到可分析的报表数据' })
    }
    const db = await loadDb()
    const cur = db.analysis || {}
    const analysis = {
      ...cur,
      daily: { ...(cur.daily || {}), ...parsed.daily },
      products: { ...(cur.products || {}), ...parsed.products },
      employeeMonthly: { ...(cur.employeeMonthly || {}), ...parsed.employeeMonthly },
      employees: parsed.employees || cur.employees || [],
      months: [...new Set([...(cur.months || []), ...parsed.months])].sort(),
      sourceFiles: [...new Set([...(cur.sourceFiles || []), ...parsed.sourceFiles])],
      uploadedAt: new Date().toISOString(),
    }
    db.analysis = analysis
    await persist()
    const summary = {
      months: analysis.months,
      dailyRows: Object.values(analysis.daily || {}).reduce(
        (s, stores) => s + Object.values(stores).reduce((a, rows) => a + rows.length, 0),
        0,
      ),
      productCount: Object.values(analysis.products || {}).reduce(
        (s, stores) => s + Object.values(stores).reduce((a, list) => a + list.length, 0),
        0,
      ),
      employeeCount: (analysis.employees || []).length,
      sourceFiles: analysis.sourceFiles,
    }
    res.json({ ok: true, summary })
  })

  app.delete('/api/analysis', requireAuth, requireOperational, async (req, res) => {
    const db = await loadDb()
    db.analysis = {}
    await persist()
    res.json({ ok: true })
  })

  // ---------- 静态前端（仅本地/自建服务器模式使用；Vercel 由平台托管前端） ----------
  app.use(express.static(DIST))
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) return next()
    const index = path.join(DIST, 'index.html')
    if (fs.existsSync(index)) return res.sendFile(index)
    res.status(404).json({ error: '前端未构建，请先运行 npm run build' })
  })

  return app
}
