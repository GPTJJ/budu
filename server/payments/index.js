import { prisma } from '../pg.js'
import { PaymentService } from './payment-service.js'

export const paymentService = new PaymentService(prisma)
