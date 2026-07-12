# Build Onlook web client
FROM oven/bun:1.3.1

WORKDIR /app

# Set build and production environment
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV STANDALONE_BUILD=true
ENV HOSTNAME=0.0.0.0
ENV PORT=3200

# Install Node.js 22 to RUN the standalone server.
# The Next.js standalone server must run under Node, not Bun: Bun breaks the `ws`
# package's WebSocket upgrade ("Unexpected server response: 101"), which the
# CodeSandbox SDK relies on to create sandboxes (GitHub import / project sandboxes).
# Bun is still used for install + build below.
RUN apt-get update \
    && apt-get install -y curl ca-certificates git \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Copy everything (monorepo structure)
COPY . .

# Install dependencies and build
RUN bun install
RUN cd apps/web/client && bun run build:standalone

# Expose the application port
EXPOSE 3200

# Health check to ensure the application is running
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://localhost:' + (process.env.PORT || '3200')).then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Start the Next.js server under Node (NOT Bun — see note above)
CMD ["node", "apps/web/client/.next/standalone/apps/web/client/server.js"]
