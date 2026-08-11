# ---------- 构建阶段 ----------
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
# 跳过 postinstall，避免依赖尚未装完时执行 vite build
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build

# ---------- 运行阶段 ----------
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
  && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY server ./server
COPY shared ./shared
COPY prisma ./prisma
COPY scripts ./scripts

# 生成 Prisma Client（migrate deploy 与 v2 接口使用）
RUN npx prisma generate

# 本地 JSON 模式需要可写数据目录（Upstash 模式下不影响）
RUN mkdir -p /app/server/data && chown -R node:node /app/server

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null 2>&1 || exit 1

CMD ["sh", "-c", "npx prisma migrate deploy && node server/index.js"]
