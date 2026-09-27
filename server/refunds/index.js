import { prisma } from '../pg.js'
import { ManualExternalRefundService } from './manual-external-refund-service.js'

export const manualExternalRefundService = new ManualExternalRefundService(prisma)
