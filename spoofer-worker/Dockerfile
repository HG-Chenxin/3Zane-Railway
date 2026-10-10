FROM node:22-slim

WORKDIR /app
COPY spoofer-worker/package.json spoofer-worker/package-lock.json ./
RUN npm ci --omit=dev

COPY roblox-asset-download.js railway-object-storage.js account-limits.js api-rate-limit.js ./
COPY spoofer-worker/server.js spoofer-worker/auth.js spoofer-worker/job-validation.js spoofer-worker/download-integrity.js ./spoofer-worker/

ENV NODE_ENV=production
EXPOSE 8790
CMD ["node", "spoofer-worker/server.js"]
