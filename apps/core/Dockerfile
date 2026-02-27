FROM node:20-slim AS base
WORKDIR /app

RUN npm install -g pnpm@9

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/ ./packages/
COPY apps/core/ ./apps/core/
COPY scripts/ ./scripts/

RUN pnpm install --frozen-lockfile

ENV NODE_ENV=production

EXPOSE 3002
CMD ["pnpm", "tsx", "--tsconfig", "tsconfig.base.json", "apps/core/src/index.ts"]
