FROM node:22-bookworm-slim
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile=false
COPY . .
RUN pnpm build
CMD ["node", "dist/apps/control-api/src/main.js"]
