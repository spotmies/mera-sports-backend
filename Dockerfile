# Railway builds this image instead of using Railpack. Railpack downloads its
# tooling (mise) from GitHub releases on every build, so a GitHub outage
# (504s, Nov 2026) failed every deploy before it reached our code. This needs
# only the Node image from Docker Hub and the npm registry.
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

# Dependencies first, so an unchanged lockfile reuses this layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .

# Railway sets PORT; server.js reads it.
EXPOSE 5000

# Apply pending database migrations, then start the server. `--soft` means a
# migration problem is logged loudly but never stops the server from starting
# (see db/migrate.mjs). `exec` keeps node as PID 1 so Railway's stop signal
# still reaches it.
CMD ["sh", "-c", "node db/migrate.mjs --soft; exec node server.js"]
