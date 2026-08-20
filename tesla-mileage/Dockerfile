# The ledger of record wants a host that stays on. This image is that host.
#
# Nothing is compiled and nothing is installed: Node runs the TypeScript
# directly, and the database is Node's own SQLite. The image is the runtime plus
# this source tree.
FROM node:22-alpine

# node:sqlite is still flagged experimental in Node 22, so silence that one
# warning rather than every warning.
ENV NODE_OPTIONS=--no-warnings=ExperimentalWarning \
    MILE_LEDGER_HOST=0.0.0.0 \
    PORT=8730 \
    MILE_LEDGER_DB=/data/mileage.db

WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src

# The ledger lives on a volume, so it survives the container.
VOLUME ["/data"]
EXPOSE 8730

# Set a passcode before exposing this beyond your own network:
#   docker run -e MILE_LEDGER_PASSCODE=... -e MILE_LEDGER_SECRET=... ...
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8730)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.ts"]
