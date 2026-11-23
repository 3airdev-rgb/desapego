# Imagem de produção do Desapego (usada tanto no Docker Desktop quanto na VPS).
FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

# Dependências primeiro, para aproveitar o cache de camadas.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public

# Banco e fotos ficam em /app/data, montado como volume.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

EXPOSE 3111
CMD ["node", "src/server.js"]
