# For any container host (Fly.io, Railway, Koyeb, a VPS...).
FROM node:22.20-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY . .
RUN npm run build && npm prune --omit=dev
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node", "server/index.ts"]
