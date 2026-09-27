import fs from 'node:fs'
import {auditOnlineCatalog} from '../server/online-catalog-coverage.js'
const [catalogPath,evidencePath]=process.argv.slice(2)
if(!catalogPath||!evidencePath)throw Error('FRESH_CATALOG_AND_POLICY_SNAPSHOT_REQUIRED')
const e=JSON.parse(fs.readFileSync(evidencePath)),products=JSON.parse(fs.readFileSync(catalogPath))
const result=auditOnlineCatalog({products,policies:e.policies,canonicalProducts:e.products,blacklist:e.blacklist})
console.log(JSON.stringify(result,null,2));if(result.status!=='PASS')process.exitCode=1
