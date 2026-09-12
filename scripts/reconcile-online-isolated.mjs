import fs from 'node:fs'
import {PrismaClient} from '@prisma/client'
import {reconcileOnlineFinancials} from '../server/online-reconciliation.js'
const config=JSON.parse(fs.readFileSync(process.env.SC11B_NATIVE_CONFIG))
if(config.host!=='127.0.0.1'||config.database!=='budu_sc11b_native')throw Error('ISOLATED_NATIVE_DB_REQUIRED')
const prisma=new PrismaClient({datasourceUrl:`postgresql://${config.user}:${config.password}@${config.host}:${config.port}/${config.database}`})
try{
  const result=await reconcileOnlineFinancials(prisma)
  console.log(JSON.stringify(result,null,2))
  if(!result.pass)process.exitCode=1
}catch{console.error('ISOLATED_RECONCILIATION_FAILED');process.exitCode=1}
finally{await prisma.$disconnect()}
