# ---------- Builder: builds only the server (esbuild) ----------
# Deliberately WITHOUT the client: the client is hosted elsewhere,
# only the hub/worker runs in the image (WS + /healthz).
FROM node:22-alpine AS builder
WORKDIR /app

# Copy the server manifest first -> better Docker layer cache
COPY server/package.json ./server/package.json

# server needs ws + esbuild
RUN npm --prefix server install

# shared/ is bundled into the server bundle (sim/engine)
COPY shared/ ./shared/
COPY server/ ./server/

# Builds server/dist/server.mjs
RUN npm --prefix server run build

# ---------- Runner: minimal production image ----------
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV KONG_PORT=8765

# Only what is needed at runtime:
# - bundled server + map data (server/build.mjs maps ../assets/maps/...)
# - server/package.json for prod install (ws)
# NO client: no client/dist, no --root pointing at the client.
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/server/assets ./server/assets
COPY --from=builder /app/server/package.json ./server/package.json

# Empty web root: the server only serves WS (/ws, incl. /kong/ws compat) + /healthz,
# static files answer 404 (no client in the image). Deliberately no client in the image.
RUN mkdir -p ./server/empty-root && echo "server-only" > ./server/empty-root/.gitkeep

# Only production dependencies (ws), no esbuild
RUN npm --prefix server install --omit=dev && npm cache clean --force

# Run as non-root (the node user exists in the official image)
RUN chown -R node:node /app
USER node

# Hub port. Worker ports = hub port + 101..104 (8866-8869 at 8765),
# spawned/proxied by the hub as child processes on localhost
# and NOT to be opened to the outside.
EXPOSE 8765

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.KONG_PORT||'8765')+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

# No --port here: the KONG_PORT env stays overridable (compose / -e).
# --root points at an empty directory: pure server operation without client files.
CMD ["node", "server/dist/server.mjs", "--root=server/empty-root"]
