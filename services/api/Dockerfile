# ---- Stage 1: install production dependencies only ----
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- Stage 2: small runtime image ----
FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
# Runtime only needs "node"; remove package managers (smaller image, fewer CVEs, less attack surface)
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY certs ./certs
# Files stay owned by root (read-only to the app); the process runs as the unprivileged "node" user
USER node
EXPOSE 8080
CMD ["node", "src/index.js"]