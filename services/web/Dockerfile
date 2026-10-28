# ---- Stage 1: build the static site ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- Stage 2: serve it with unprivileged nginx (runs as UID 101, listens on 8080) ----
FROM nginxinc/nginx-unprivileged:stable-alpine
# Base images lag behind security fixes: pull the latest patched Alpine packages at build time
# (needs root briefly), then drop back to the unprivileged nginx user.
USER root
RUN apk upgrade --no-cache
USER 101
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080