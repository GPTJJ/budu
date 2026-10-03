import { prisma } from './pg.js';
import { id } from './purchase-receipt-core.js';
import { developerWecomRecipientBinding, wechatPersonalConfig, sendWechatPersonal, notificationDeepLink } from './notification-center.js';
let testSender = null;
export function setProcurementTestSender(sender) {
  if (process.env.APP_ENV !== 'test') throw new Error('test sender only');
  testSender = sender;
}
export async function createReceiptNotice(tx, receipt, order) {
  const developer = await tx.user.findUnique({
    where: {
      username: 'budu'
    }
  });
  const eventId = 'pre-' + receipt.id + '-' + receipt.revision;
  const notificationId = 'pn-' + receipt.id + '-' + receipt.revision;
  const lines = receipt.lines.map(x => {
    const l = order.lines.find(l => l.id === x.orderLineId);
    return l.productNameSnapshot + ' ' + x.receivedQty.toString() + ' ' + l.unitSnapshot;
  });
  const content = [order.supplierNameSnapshot, order.storeNameSnapshot, '提交人：' + receipt.submittedByName, '本次到货：', ...lines].join('\n');
  const valid = developer?.role === 'developer' && developer.status === 'active';
  if (valid) {
    await tx.notification.create({
      data: {
        id: notificationId,
        username: developer.username,
        templateKey: 'purchase_receipt_submitted',
        title: '收货待核准',
        content,
        target: 'inventory-purchase',
        refType: 'purchase_receipt',
        refId: receipt.id
      }
    });
    await tx.notificationDelivery.create({
      data: {
        id: id('nd'),
        notificationId,
        channel: 'inapp',
        status: 'sent'
      }
    });
  }
  await tx.procurementNotificationEvent.create({
    data: {
      id: eventId,
      receiptId: receipt.id,
      submissionRevision: receipt.revision,
      recipientUserId: valid ? developer.id : 'missing',
      notificationId,
      status: valid ? 'PENDING' : 'FAILED',
      errorCode: valid ? '' : 'DEVELOPER_NOT_CONFIGURED'
    }
  });
  return eventId;
}
export async function deliverReceiptNotice(eventId, {
  retry = false
} = {}) {
  const claimed = await prisma.procurementNotificationEvent.updateMany({
    where: {
      id: eventId,
      status: retry ? 'FAILED' : 'PENDING'
    },
    data: {
      status: 'SENDING',
      attemptCount: {
        increment: 1
      },
      errorCode: ''
    }
  });
  if (!claimed.count) return;
  const event = await prisma.procurementNotificationEvent.findUnique({
    where: {
      id: eventId
    }
  });
  const nt = await prisma.notification.findUnique({
    where: {
      id: event.notificationId
    }
  });
  const developer = await prisma.user.findUnique({
    where: {
      id: event.recipientUserId
    }
  });
  const binding = developerWecomRecipientBinding(),
    cfg = wechatPersonalConfig();
  const deliveryId = event.id + '-wecom';
  if (!nt || developer?.role !== 'developer' || developer.status !== 'active' || !binding || binding.username !== nt.username) {
    await prisma.procurementNotificationEvent.update({
      where: {
        id: eventId
      },
      data: {
        status: 'FAILED',
        errorCode: 'CHANNEL_OR_DEVELOPER_NOT_CONFIGURED'
      }
    });
    return;
  }
  // The recipient is an enterprise WeChat userid. Never reinterpret it as
  // an MP openId when the enterprise channel configuration is unavailable.
  if (!cfg || cfg.channel !== 'wecom') {
    await prisma.procurementNotificationEvent.update({
      where: { id: eventId },
      data: { status: 'FAILED', errorCode: 'WECOM_CHANNEL_UNAVAILABLE' }
    });
    return;
  }
  await prisma.notificationDelivery.upsert({
    where: {
      id: deliveryId
    },
    create: {
      id: deliveryId,
      notificationId: nt.id,
      channel: 'wecom',
      status: 'pending'
    },
    update: {
      status: 'pending',
      error: ''
    }
  });
  const full = nt.content;
  const suffix = '\n共' + full.split('\n').slice(4).length + '项，完整本次明细见详情';
  let content = full;
  if (full.length > 500) {
    const rows = full.split('\n');
    let excerpt = '';
    for (const row of rows) {
      if ((excerpt + row + '\n' + suffix).length > 500) break;
      excerpt += row + '\n';
    }
    content = excerpt + suffix;
  }
  let result;
  try {
    result = await (testSender || sendWechatPersonal)(cfg, {
      openId: binding.userId
    }, {
      title: nt.title,
      content,
      target: nt.target,
      url: notificationDeepLink(nt.target, nt.refType, nt.refId)
    });
  } catch {
    result = {
      ok: false,
      errcode: 'UNKNOWN'
    };
  }
  // Transport ambiguity is never retried automatically.
  const unknown = !result.ok && ['UNKNOWN', 'LOCAL_ERROR', 'TOKEN_FETCH_FAILED'].includes(String(result.errcode));
  const status = result.ok ? 'SENT' : unknown ? 'UNKNOWN' : 'FAILED';
  await prisma.$transaction([prisma.procurementNotificationEvent.update({
    where: {
      id: eventId
    },
    data: {
      status,
      errorCode: result.ok ? '' : String(result.errcode || 'FAILED')
    }
  }), prisma.notificationDelivery.update({
    where: {
      id: deliveryId
    },
    data: {
      status: status.toLowerCase(),
      error: result.ok ? '' : String(result.errcode || 'FAILED'),
      sentAt: new Date()
    }
  })]);
}
export async function receiptDeliverySummary(receiptId) {
  const events = await prisma.procurementNotificationEvent.findMany({
    where: {
      receiptId
    },
    select: {
      id: true,
      submissionRevision: true,
      status: true,
      errorCode: true,
      attemptCount: true,
      updatedAt: true
    }
  });
  return events.map(e => e.status === 'SENDING' && Date.now() - e.updatedAt.getTime() > 120000 ? {
    ...e,
    status: 'UNKNOWN',
    errorCode: 'UNCONFIRMED_DELIVERY'
  } : e);
}
