# x402 optimize server. Runs TS directly via tsx (no build step).
FROM node:20-alpine
WORKDIR /app

# Install deps first for layer caching. tsx is a devDependency, so install all.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

EXPOSE 8080
CMD ["npm", "run", "start"]
