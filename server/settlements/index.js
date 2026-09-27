import { prisma } from '../pg.js'
import { ExternalSettlementService } from './external-settlement-service.js'

export const externalSettlementService = new ExternalSettlementService(prisma)
