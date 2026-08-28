#!/usr/bin/env node
/**
 * Production-only deployment audit for the fixed CustomerRequest WeCom recipient.
 *
 * The resulting UserID is written to a mode-0600 file and is never printed. Runtime
 * delivery uses only CUSTOMER_REQUEST_WECOM_RECIPIENT_USER_ID; this script performs
 * a one-time, independently cross-checked mobile-to-UserID lookup before that setting is
 * installed. An existing active BUDU WechatBinding is the primary authority;
 * canonical Employee mobile lookup is only a verified fallback.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import { PrismaClient } from '@prisma/client'
import { wechatPersonalConfig, wecomAccessToken } from '../server/notification-center.js'

const outputPath = process.argv[2]
if (!outputPath || !outputPath.startsWith('/')) throw new Error('ABSOLUTE_OUTPUT_PATH_REQUIRED')

const prisma = new PrismaClient()
const normalizePhone = (value) => String(value || '').replace(/\D/g, '')
const normalizeEmail = (value) => String(value || '').trim().toLowerCase()
const validUserId = (value) => /^[A-Za-z0-9._@-]{1,64}$/.test(String(value || ''))

try {
  const users = await prisma.user.findMany({
    where: { displayName: '胡东辉', disabledAt: null },
    select: { id: true, username: true },
  })
  if (users.length !== 1) throw new Error(`BUDU_USER_CARDINALITY_${users.length}`)

  const cfg = wechatPersonalConfig()
  if (!cfg || cfg.channel !== 'wecom') throw new Error('WECOM_APP_CONFIG_UNAVAILABLE')
  const accessToken = await wecomAccessToken(cfg.corpId, cfg.secret)
  if (!accessToken) throw new Error('WECOM_ACCESS_TOKEN_UNAVAILABLE')

  const bindings = await prisma.wechatBinding.findMany({
    where: { username: users[0].username, channel: 'wecom', status: 'active' },
    select: { openId: true },
  })
  if (bindings.length > 1) throw new Error(`WECOM_BINDING_CARDINALITY_${bindings.length}`)

  let userId = bindings[0]?.openId?.trim() || ''
  let bindingAuthority = Boolean(userId)
  let mobileToUserIdLookup = false
  let stableAccountCrossCheck = false
  let employee = null
  let detail = null
  if (!userId && validUserId(users[0].username)) {
    const accountDetailUrl = new URL('https://qyapi.weixin.qq.com/cgi-bin/user/get')
    accountDetailUrl.searchParams.set('access_token', accessToken)
    accountDetailUrl.searchParams.set('userid', users[0].username)
    const accountDetailResponse = await fetch(accountDetailUrl, { signal: AbortSignal.timeout(8000) })
    const accountDetail = await accountDetailResponse.json().catch(() => ({}))
    if (
      accountDetailResponse.ok
      && accountDetail.errcode === 0
      && accountDetail.userid === users[0].username
      && accountDetail.name === '胡东辉'
    ) {
      userId = users[0].username
      detail = accountDetail
      stableAccountCrossCheck = true
    }
  }
  if (!userId) {
    const employees = await prisma.employee.findMany({
      where: { userId: users[0].id },
      include: { profile: true },
    })
    if (employees.length !== 1 || employees[0].name !== '胡东辉') {
      throw new Error(`BUDU_EMPLOYEE_BINDING_CARDINALITY_${employees.length}`)
    }
    employee = employees[0]
    const buduPhone = normalizePhone(employee.profile?.phone)
    if (!/^1[3-9]\d{9}$/.test(buduPhone)) throw new Error('BUDU_VERIFIED_MOBILE_UNAVAILABLE')
    const lookupUrl = new URL('https://qyapi.weixin.qq.com/cgi-bin/user/getuserid')
    lookupUrl.searchParams.set('access_token', accessToken)
    const lookupResponse = await fetch(lookupUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobile: buduPhone }),
      signal: AbortSignal.timeout(8000),
    })
    const lookup = await lookupResponse.json().catch(() => ({}))
    if (!lookupResponse.ok || lookup.errcode !== 0 || typeof lookup.userid !== 'string') {
      throw new Error(`WECOM_MOBILE_LOOKUP_${lookup.errcode ?? lookupResponse.status}`)
    }
    userId = lookup.userid.trim()
    mobileToUserIdLookup = true
  }
  if (!validUserId(userId)) throw new Error('WECOM_USER_ID_SHAPE_INVALID')

  if (!detail) {
    const detailUrl = new URL('https://qyapi.weixin.qq.com/cgi-bin/user/get')
    detailUrl.searchParams.set('access_token', accessToken)
    detailUrl.searchParams.set('userid', userId)
    const detailResponse = await fetch(detailUrl, { signal: AbortSignal.timeout(8000) })
    detail = await detailResponse.json().catch(() => ({}))
    if (!detailResponse.ok || detail.errcode !== 0 || detail.userid !== userId || detail.name !== '胡东辉') {
      throw new Error(`WECOM_DETAIL_${detail.errcode ?? detailResponse.status}`)
    }
  }

  const wecomPhone = normalizePhone(detail.mobile)
  const buduPhone = normalizePhone(employee?.profile?.phone)
  const buduEmail = normalizeEmail(employee?.profile?.email)
  const wecomEmail = normalizeEmail(detail.email)
  const phoneCrossCheck = Boolean(employee && buduPhone && wecomPhone && buduPhone === wecomPhone)
  const emailCrossCheck = Boolean(buduEmail && wecomEmail && buduEmail === wecomEmail)
  stableAccountCrossCheck = stableAccountCrossCheck || users[0].username === userId
  if (!bindingAuthority && !stableAccountCrossCheck && !phoneCrossCheck) {
    throw new Error('WECOM_IDENTITY_CROSS_CHECK_FAILED')
  }

  fs.writeFileSync(outputPath, `${userId}\n`, { encoding: 'utf8', mode: 0o600, flag: 'w' })
  fs.chmodSync(outputPath, 0o600)
  process.stdout.write(`${JSON.stringify({
    buduUserCount: users.length,
    activeWecomBinding: bindingAuthority,
    canonicalEmployeeBinding: Boolean(employee),
    mobileToUserIdLookup,
    detailEndpointVerified: true,
    phoneCrossCheck,
    emailCrossCheck,
    stableAccountCrossCheck,
    userIdFingerprint: crypto.createHash('sha256').update(userId).digest('hex').slice(0, 12),
  })}\n`)
} finally {
  await prisma.$disconnect()
}
