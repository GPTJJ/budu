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
  echo "production route authority is incomplete" >&2
  exit 1
}
[ "$(docker inspect --format '{{.State.Running}}' "$ACTIVE_CONTAINER")" = "true" ] || {
  echo "routed API is not running" >&2
  exit 1
}

docker exec -i "$ACTIVE_CONTAINER" node --input-type=module - <<'NODE'
import crypto from 'node:crypto'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
try {
  const [healthResponse, databaseRows, migrationRows, items, transferUsage, purchaseUsage] = await Promise.all([
    fetch('http://127.0.0.1:3000/api/health', { signal: AbortSignal.timeout(8000) }),
    prisma.$queryRawUnsafe('SELECT current_database() AS name'),
    prisma.$queryRawUnsafe('SELECT COUNT(*)::int AS count FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL'),
    prisma.inventoryItem.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, name: true, category: true, sku: true, barcode: true, isActive: true, sortOrder: true, version: true },
    }),
    prisma.transferItem.groupBy({ by: ['itemId'], _count: { _all: true } }),
    prisma.purchaseItem.groupBy({ by: ['itemId'], _count: { _all: true } }),
  ])
  const health = await healthResponse.json()
  const database = databaseRows[0]?.name || ''
  const migrations = Number(migrationRows[0]?.count || 0)
  if (!healthResponse.ok || health.ok !== true || health.dbOk !== true) throw new Error('PRODUCTION_HEALTH_FAILED')
  if (database !== 'budu_bj006') throw new Error('PRODUCTION_DATABASE_AUTHORITY_MISMATCH')

  const transferUsed = new Set(transferUsage.map((row) => row.itemId))
  const purchaseUsed = new Set(purchaseUsage.map((row) => row.itemId))
  const counts = { total: items.length, product: 0, material: 0, other: 0, activeProduct: 0, activeMaterial: 0, inactiveProduct: 0, inactiveMaterial: 0, usedByTransfer: transferUsed.size, usedByPurchase: purchaseUsed.size, usedAndInactive: 0 }
  for (const item of items) {
    const category = item.category === 'material' ? 'material' : item.category === 'product' ? 'product' : 'other'
    counts[category] += 1
    if (category === 'product' || category === 'material') counts[`${item.isActive ? 'active' : 'inactive'}${category[0].toUpperCase()}${category.slice(1)}`] += 1
    if (!item.isActive && (transferUsed.has(item.id) || purchaseUsed.has(item.id))) counts.usedAndInactive += 1
  }
  const canonical = items.map((item) => ({ ...item, sku: item.sku || null, barcode: item.barcode || '' }))
  console.log(JSON.stringify({
    verifiedAt: new Date().toISOString(),
    runtime: { gitSha: health.gitSha, env: health.env, ok: health.ok, dbOk: health.dbOk },
    database,
    migrations,
    counts,
    activeProducts: items.filter((item) => item.category === 'product' && item.isActive).map((item) => ({ id: item.id, name: item.name, sku: item.sku, sortOrder: item.sortOrder })),
    activeMaterials: items.filter((item) => item.category === 'material' && item.isActive).map((item) => ({ id: item.id, name: item.name, sortOrder: item.sortOrder })),
    masterDigest: crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),
  }, null, 2))
} finally {
  await prisma.$disconnect()
}
NODE
