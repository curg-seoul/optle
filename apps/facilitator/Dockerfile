# Self-hosted x402 facilitator. Runs TS directly via tsx (no build step).
FROM node:20-alpine
WORKDIR /app

# Install deps first for layer caching. tsx is a devDependency, so install all.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

EXPOSE 8090
CMD ["npm", "run", "start"]
