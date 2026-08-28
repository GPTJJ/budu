#!/usr/bin/env node
/**
 * Production deployment audit for the locked CustomerRequest notification binding.
 *
 * Authority is the exact BUDU account `budu` mapped to the exact WeCom UserID `dh`.
 * No display name, employee identity, directory search, or fuzzy matching participates.
 */
import fs from 'node:fs'
import { PrismaClient } from '@prisma/client'
import { wechatPersonalConfig, wecomAccessToken } from '../server/notification-center.js'

const outputPath = process.argv[2]
if (!outputPath || !outputPath.startsWith('/')) throw new Error('ABSOLUTE_OUTPUT_PATH_REQUIRED')

const BUDU_USERNAME = 'budu'
const WECOM_USER_ID = 'dh'
const prisma = new PrismaClient()

try {
  const users = await prisma.user.findMany({
    where: { username: BUDU_USERNAME, disabledAt: null },
    select: { username: true },
  })
  if (users.length !== 1 || users[0].username !== BUDU_USERNAME) {
    throw new Error(`BUDU_ACCOUNT_CARDINALITY_${users.length}`)
  }

  const cfg = wechatPersonalConfig()
  if (!cfg || cfg.channel !== 'wecom') throw new Error('WECOM_APP_CONFIG_UNAVAILABLE')
  const accessToken = await wecomAccessToken(cfg.corpId, cfg.secret)
  if (!accessToken) throw new Error('WECOM_ACCESS_TOKEN_UNAVAILABLE')

  const detailUrl = new URL('https://qyapi.weixin.qq.com/cgi-bin/user/get')
  detailUrl.searchParams.set('access_token', accessToken)
  detailUrl.searchParams.set('userid', WECOM_USER_ID)
  const detailResponse = await fetch(detailUrl, { signal: AbortSignal.timeout(8000) })
  const detail = await detailResponse.json().catch(() => ({}))
  if (!detailResponse.ok || detail.errcode !== 0 || detail.userid !== WECOM_USER_ID) {
    throw new Error(`WECOM_EXACT_USER_ID_INVALID_${detail.errcode ?? detailResponse.status}`)
  }

  fs.writeFileSync(
    outputPath,
    `${JSON.stringify({ username: BUDU_USERNAME, userId: WECOM_USER_ID })}\n`,
    { encoding: 'utf8', mode: 0o600, flag: 'w' },
  )
  fs.chmodSync(outputPath, 0o600)
  process.stdout.write(`${JSON.stringify({
    buduAccountVerified: true,
    exactWecomUserIdVerified: true,
    stableBinding: 'budu -> dh',
    nameBasedRouting: false,
    recipientCount: 1,
  })}\n`)
} finally {
  await prisma.$disconnect()
}
