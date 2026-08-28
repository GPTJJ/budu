#!/usr/bin/env bash
set -Eeuo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 APP_DIR NGINX_CONTAINER" >&2
  exit 2
fi

APP_DIR="$1"
NGINX_CONTAINER="$2"
HOST_TEMPLATE="${APP_DIR}/deploy/nginx/conf.d/budu.conf.template"

[ -f "$HOST_TEMPLATE" ] || { echo "production nginx authority template missing" >&2; exit 1; }
docker inspect "$NGINX_CONTAINER" >/dev/null

mapfile -t ROUTE_TARGETS < <(sed -nE 's@.*proxy_pass[[:space:]]+http://([^:/;]+):3000.*@\1@p' "$HOST_TEMPLATE" | sort -u)
[ "${#ROUTE_TARGETS[@]}" -eq 1 ] || { echo "production route authority is ambiguous" >&2; exit 1; }
ACTIVE_CONTAINER="${ROUTE_TARGETS[0]}"
[ "$(grep -Ec "proxy_pass[[:space:]]+http://${ACTIVE_CONTAINER}:3000" "$HOST_TEMPLATE")" -eq 3 ] || {
  echo "expected exactly three production API routes" >&2
  exit 1
}
docker inspect "$ACTIVE_CONTAINER" >/dev/null
[ "$(docker inspect --format '{{.State.Running}}' "$ACTIVE_CONTAINER")" = "true" ] || {
  echo "routed API is not running" >&2
  exit 1
}

docker exec -i "$ACTIVE_CONTAINER" node --input-type=module - <<'NODE'
import crypto from 'node:crypto'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
try {
  const [healthResponse, databaseRows, migrationRows, transfers] = await Promise.all([
    fetch('http://127.0.0.1:3000/api/health', { signal: AbortSignal.timeout(8000) }),
    prisma.$queryRawUnsafe('SELECT current_database() AS name'),
    prisma.$queryRawUnsafe('SELECT COUNT(*)::int AS count FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL'),
    prisma.transferRequest.findMany({
      orderBy: { id: 'asc' },
      select: {
        id: true,
        fromStoreKey: true,
        toStoreKey: true,
        fromLocationName: true,
        toLocationName: true,
        status: true,
        note: true,
        createdBy: true,
        createdAt: true,
        updatedAt: true,
        items: {
          orderBy: { id: 'asc' },
          select: {
            id: true,
            itemId: true,
            quantity: true,
            note: true,
            item: { select: { name: true, category: true, sku: true, barcode: true } },
          },
        },
      },
    }),
  ])
  const health = await healthResponse.json()
  const database = databaseRows[0]?.name || ''
  const migrations = Number(migrationRows[0]?.count || 0)
  if (!healthResponse.ok || health.ok !== true || health.dbOk !== true) throw new Error('PRODUCTION_HEALTH_FAILED')
  if (database !== 'budu_bj006') throw new Error('PRODUCTION_DATABASE_AUTHORITY_MISMATCH')

  const canonical = transfers.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    items: row.items.map((item) => ({ ...item, item: { ...item.item, sku: item.item.sku || null } })),
  }))
  const digest = crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
  const statusCounts = {}
  const fromStoreCounts = {}
  const toStoreCounts = {}
  const itemTypeCounts = { product: 0, material: 0, other: 0 }
  let itemCount = 0
  for (const row of transfers) {
    statusCounts[row.status] = (statusCounts[row.status] || 0) + 1
    const from = row.fromStoreKey || `[legacy-location] ${row.fromLocationName || '—'}`
    const to = row.toStoreKey || `[legacy-location] ${row.toLocationName || '—'}`
    fromStoreCounts[from] = (fromStoreCounts[from] || 0) + 1
    toStoreCounts[to] = (toStoreCounts[to] || 0) + 1
    for (const detail of row.items) {
      itemCount += 1
      const category = ['product', 'material'].includes(detail.item.category) ? detail.item.category : 'other'
      itemTypeCounts[category] += 1
    }
  }
  const result = {
    verifiedAt: new Date().toISOString(),
    runtime: { gitSha: health.gitSha, env: health.env, ok: health.ok, dbOk: health.dbOk },
    database,
    migrations,
    transferBaseline: {
      totalTransfers: transfers.length,
      totalItems: itemCount,
      earliestCreatedAt: transfers.at(0)?.createdAt?.toISOString() || null,
      latestCreatedAt: transfers.at(-1)?.createdAt?.toISOString() || null,
      statusCounts,
      fromStoreCounts,
      toStoreCounts,
      itemTypeCounts,
      canonicalDigest: digest,
    },
  }
  console.log(JSON.stringify(result, null, 2))
} finally {
  await prisma.$disconnect()
}
NODE
