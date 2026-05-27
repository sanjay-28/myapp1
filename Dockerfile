# ── Stage 1: deps ───────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
# Uses install to safely build dynamically without forcing lockfile crashes
RUN npm install

# ── Stage 2: final image ─────────────────────────────────
FROM node:20-alpine
WORKDIR /app

# Non-root user for cloud container execution security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Cloud Run requires PORT 8080
ENV PORT=8080 NODE_ENV=production

USER appuser
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:8080/health || exit 1

CMD ["node", "server.js"]
