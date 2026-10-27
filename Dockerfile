# 国内构建默认走 DaoCloud 代理，避免 Docker Hub 超时；海外可改为 node:20-bullseye
ARG NODE_IMAGE=docker.m.daocloud.io/library/node:20-bullseye
FROM ${NODE_IMAGE}

WORKDIR /app

ENV NODE_ENV=production

COPY package.json ./
COPY server.js ./
COPY public ./public
COPY seed ./seed
COPY config.example.json ./config.example.json

RUN mkdir -p data uploads \
  && cp config.example.json config.json

EXPOSE 8789

CMD ["node", "server.js"]
