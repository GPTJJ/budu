// 账号存储层（Data Authority DA-2：PostgreSQL 唯一权威；KV users 仅回滚镜像，best-effort 写入）
// 所有账号读写统一走本模块；迁移期保留 KV 镜像写（回滚时 KV 仍是最新），DA-5 移除镜像。
import { prisma, dbReady } from './pg.js'
import { loadDb, persist } from './store.js'
import { normalizeAccountPermissions } from '../shared/accountPermissions.js'

/** KV 账号镜像（best-effort；失败不影响 PG 权威） */
async function mirrorUsersToKv() {
  try {
    const db = await loadDb()
    const rows = await prisma.user.findMany({ orderBy: { createdAt: 'asc' } })
    db.users = rows.map(toKvUser)
    await persist()
  } catch {
    /* 镜像失败不影响权威 */
  }
}

/** PG 行 → 前端账号对象（与原 KV user 形状一致） */
export function toAppUser(row) {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.passwordHash || '',
    displayName: row.displayName || '',
    role: row.role,
    storeKeys: Array.isArray(row.storeKeys) ? row.storeKeys : [],
    staffKey: row.staffKey || '',
    employeeId: row.employeeId || '',
    status: row.status || 'active',
    secondPasswordHash: row.secondPasswordHash || '',
    bindingLegacyExempt: Boolean(row.bindingLegacyExempt),
    assetCenter: Boolean(row.assetCenter),
    permissions: normalizeAccountPermissions(row.permissions, row.role, Boolean(row.assetCenter)),
    permissionsUpdatedAt: row.permissionsUpdatedAt || '',
    permissionsUpdatedBy: row.permissionsUpdatedBy || '',
    avatar: row.avatar || '',
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : '',
  }
}

/** 前端账号对象 → PG 写入数据 */
function toPgData(user) {
  return {
    id: user.id,
    username: String(user.username || ''),
    passwordHash: String(user.passwordHash || ''),
    role: String(user.role || 'staff'),
    displayName: String(user.displayName || ''),
    avatar: String(user.avatar || ''),
    storeKeys: Array.isArray(user.storeKeys) ? user.storeKeys : [],
    staffKey: String(user.staffKey || ''),
    employeeId: String(user.employeeId || ''),
    status: String(user.status || 'active'),
    secondPasswordHash: String(user.secondPasswordHash || ''),
    bindingLegacyExempt: Boolean(user.bindingLegacyExempt),
    assetCenter: Boolean(user.assetCenter),
    permissions: user.permissions && typeof user.permissions === 'object' ? user.permissions : {},
    disabledAt: user.disabledAt || null,
    permissionsUpdatedAt: user.permissionsUpdatedAt ? new Date(user.permissionsUpdatedAt) : null,
    permissionsUpdatedBy: String(user.permissionsUpdatedBy || ''),
    createdAt: user.createdAt ? new Date(user.createdAt) : new Date(),
  }
}

/** KV 行 → 镜像对象（保形） */
export function toKvUser(row) {
  const app = toAppUser(row)
  return { ...app, disabledAt: row.disabledAt || null, permissions: app.permissions }
}

export async function getUserById(id) {
  if (!dbReady()) return null
  const row = await prisma.user.findUnique({ where: { id } })
  return row ? toAppUser(row) : null
}

export async function getUserByUsername(username) {
  if (!dbReady()) return null
  const row = await prisma.user.findUnique({ where: { username } })
  return row ? toAppUser(row) : null
}

export async function listUsers() {
  if (!dbReady()) return []
  const rows = await prisma.user.findMany({ orderBy: { createdAt: 'asc' } })
  return rows.map(toAppUser)
}

export async function createUser(user) {
  const data = toPgData(user)
  const row = await prisma.user.create({ data })
  await mirrorUsersToKv()
  return toAppUser(row)
}

export async function updateUser(id, patch) {
  const data = {}
  for (const key of ['username', 'passwordHash', 'role', 'displayName', 'avatar', 'storeKeys', 'staffKey', 'employeeId', 'status', 'secondPasswordHash', 'bindingLegacyExempt', 'assetCenter', 'permissions', 'disabledAt', 'permissionsUpdatedAt', 'permissionsUpdatedBy']) {
    if (patch[key] !== undefined) data[key] = patch[key]
  }
  const row = await prisma.user.update({ where: { id }, data })
  await mirrorUsersToKv()
  return toAppUser(row)
}

export async function deleteUser(id) {
  await prisma.user.delete({ where: { id } })
  await mirrorUsersToKv()
}
