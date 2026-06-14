# x402 optimize server. Runs TS directly via tsx (no build step).
FROM node:20-alpine
WORKDIR /app

# docker CLI: the server spawns a sibling runner container per job via the
# mounted docker socket. (No daemon here — just the client talking to the host.)
RUN apk add --no-cache docker-cli

# Install deps first for layer caching. tsx is a devDependency, so install all.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

EXPOSE 8080
CMD ["npm", "run", "start"]
