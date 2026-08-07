import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis

export const prisma = globalForPrisma.__buduPrisma || new PrismaClient()
if (process.env.NODE_ENV !== 'production') globalForPrisma.__buduPrisma = prisma

export function dbReady() {
  return Boolean(process.env.DATABASE_URL)
}
