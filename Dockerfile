# syntax=docker/dockerfile:1
# Airplane Games backend image. Build: docker build -t airplane-games-backend:local .
# Migrations are NOT run by this image; run `npm run db:migrate` as a separate release step.

FROM node:24.22.1-trixie-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY nest-cli.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24.22.1-trixie-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# The official image ships an unprivileged "node" user.
USER node
EXPOSE 3000
# Liveness only (no database). APP_ENV, DATABASE_URL and the Firebase settings come from the environment.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
