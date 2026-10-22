# ==============================================================================
# Stage 1: Dependencies Builder
# ==============================================================================
FROM node:20-alpine AS builder

WORKDIR /usr/src/app

# Install dependencies cleanly
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# ==============================================================================
# Stage 2: Production Minimal Runner
# ==============================================================================
FROM node:20-alpine AS runner

# Install curl for container-level healthchecks
RUN apk add --no-cache curl tzdata

# Security best practice: run as non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /usr/src/app

# Copy production node_modules from builder
COPY --from=builder --chown=appuser:appgroup /usr/src/app/node_modules ./node_modules

# Copy application source files
COPY --chown=appuser:appgroup package.json ./
COPY --chown=appuser:appgroup server.js ./
COPY --chown=appuser:appgroup public ./public

# Environment configuration
ENV NODE_ENV=production \
    PORT=3000

# Switch to unprivileged user
USER appuser

EXPOSE 3000

# Built-in Container Healthcheck
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1

# Start the application
CMD ["node", "server.js"]
