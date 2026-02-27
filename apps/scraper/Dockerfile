FROM node:20-bookworm-slim AS base
WORKDIR /app

# Install pnpm
RUN npm install -g pnpm@9

# Copy workspace config files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./

# Copy only the packages needed for the scraper
COPY packages/types/ ./packages/types/
COPY apps/scraper/ ./apps/scraper/

# Install deps
RUN pnpm install --frozen-lockfile

ENV NODE_ENV=production

EXPOSE 3001
CMD ["npx", "tsx", "--tsconfig", "tsconfig.base.json", "apps/scraper/src/index.ts"]
