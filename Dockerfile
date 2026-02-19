# ─── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npx prisma generate
RUN npm run build


# ─── Production stage ──────────────────────────────────────────────────────────
FROM node:20-alpine AS production
WORKDIR /app

ENV NODE_ENV=production

# Install only production deps
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy built output and Prisma client
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY prisma ./prisma

# Create temp directory for Drive uploads
RUN mkdir -p /tmp/mission-ignite-uploads && chown node:node /tmp/mission-ignite-uploads

# Railway / Render inject PORT via environment variable
# Default to 4000 if not set
EXPOSE ${PORT:-4000}

# Security: Run as non-root user
USER node

# Healthcheck — works on both Railway and Render
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://localhost:${PORT:-4000}/api/v1/health || exit 1

# Run migrations then start the app
# NOTE: Prisma migrate deploy uses DIRECT_URL (bypasses pgBouncer)
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main"]
