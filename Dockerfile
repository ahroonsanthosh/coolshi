# For any container host (Fly.io, Railway, Koyeb, a VPS...).
FROM node:22.20-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY . .
RUN npm run build && npm prune --omit=dev
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
# A heap cap under the 512 MB instance, so V8 collects before the host kills it.
CMD ["node", "--max-old-space-size=384", "server/index.ts"]
