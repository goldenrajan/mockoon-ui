# syntax=docker/dockerfile:1.6

FROM node:22-alpine AS builder

WORKDIR /workspace

# Dependencies required for node-gyp and Angular builds
RUN apk add --no-cache python3 make g++ git

COPY package.json package-lock.json lerna.json tsconfig.json ./
COPY packages ./packages
COPY shared ./shared
COPY tsconfig.json ./tsconfig.json
COPY .npmrc ./

RUN npm ci
RUN npm run build:libs
RUN npm run build:web:prod

FROM node:22-alpine

ARG version=latest

RUN apk --no-cache add curl tzdata

WORKDIR /opt/mockoon

COPY --from=builder /workspace/packages/app/dist/renderer ./ui
COPY packages/cli/docker/runtime ./runtime

RUN cd runtime && npm ci --omit=dev
RUN npm install -g @mockoon/cli@$version

RUN adduser --shell /bin/sh --disabled-password --gecos "" mockoon && \
    mkdir -p /data && \
    chown -R mockoon:mockoon /opt/mockoon /data

USER mockoon

ENV MOCKOON_DATA_DIR=/data \
    MOCKOON_ENV_SUBDIR=environments \
    MOCKOON_UI_DIST=/opt/mockoon/ui \
    MOCKOON_UI_PORT=8080 \
    MOCKOON_API_PREFIX=/storage

VOLUME ["/data"]

EXPOSE 3000 8080

ENTRYPOINT ["node", "/opt/mockoon/runtime/entrypoint.js"]
