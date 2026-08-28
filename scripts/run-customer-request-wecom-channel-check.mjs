#!/usr/bin/env node
/** Production-safe channel check: exactly one synthetic message to the fixed UserID. */
import {
  customerRequestWecomRecipientBinding,
  customerRequestWecomRecipientUserId,
  sendWechatPersonal,
  wechatPersonalConfig,
} from '../server/notification-center.js'

const cfg = wechatPersonalConfig()
const recipientBinding = customerRequestWecomRecipientBinding()
const recipientUserId = customerRequestWecomRecipientUserId()
if (!cfg || cfg.channel !== 'wecom' || recipientBinding?.username !== 'budu' || recipientUserId !== 'dh') {
  throw new Error('WECOM_CHANNEL_NOT_READY')
}

const result = await sendWechatPersonal(
  cfg,
  { openId: recipientUserId },
  {
    title: '【BUDU 系统测试】',
    content: 'Customer Request 企业微信通知通道验证成功',
    target: '',
  },
)
if (!result.ok) throw new Error(`WECOM_CHANNEL_CHECK_FAILED_${result.errcode || 'UNKNOWN'}`)
process.stdout.write(`${JSON.stringify({ ok: true, binding: 'budu -> dh', recipientCount: 1, retried: Boolean(result.retried) })}\n`)
