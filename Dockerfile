FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY vite.config.js ./
COPY web ./web
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production TZ=Asia/Tehran
RUN apk add --no-cache tzdata
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3400
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3400/healthz >/dev/null || exit 1
CMD ["node", "server/index.js"]
