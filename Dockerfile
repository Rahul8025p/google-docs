# ─── Stage 1: Install dependencies ──────────────────────
FROM node:20-alpine AS deps

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# ─── Stage 2: Production image ──────────────────────────
FROM node:20-alpine AS runtime

# Security: run as non-root user
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup

WORKDIR /app

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application files
COPY server.js ot-engine.js ot-client.js editor.js index.html styles.css ./
COPY package.json ./

# Set ownership to non-root user
RUN chown -R appuser:appgroup /app

USER appuser

# Environment defaults
ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

# Health check (cloud hosts also use /health endpoint)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

CMD ["node", "server.js"]
