// 上传备份文件到腾讯云 COS（需配置 COS_SECRET_ID/KEY/BUCKET/REGION；未配置则跳过）
import fs from 'node:fs'
import path from 'node:path'
import COS from 'cos-nodejs-sdk-v5'

function loadEnv() {
  for (const p of ['/opt/budu/.env.production', '.env.local', '.env']) {
    if (!fs.existsSync(p)) continue
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (!m) continue
      let v = m[2].trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      if (!(m[1] in process.env)) process.env[m[1]] = v
    }
  }
}

loadEnv()

const { COS_SECRET_ID, COS_SECRET_KEY, COS_BUCKET, COS_REGION } = process.env
if (!COS_SECRET_ID || !COS_SECRET_KEY || !COS_BUCKET || !COS_REGION) {
  console.log('COS 未配置，跳过上传')
  process.exit(0)
}

const file = process.argv[2]
if (!file || !fs.existsSync(file)) {
  console.error('缺少备份文件')
  process.exit(1)
}

const cos = new COS({ SecretId: COS_SECRET_ID, SecretKey: COS_SECRET_KEY })
const Key = `budu-backups/${path.basename(file)}`
cos.putObject({ Bucket: COS_BUCKET, Region: COS_REGION, Key, Body: fs.createReadStream(file) }, (err, data) => {
  if (err) {
    console.error('COS 上传失败：', err.message)
    process.exit(1)
  }
  console.log('COS 上传成功：', data.Location || Key)
})
