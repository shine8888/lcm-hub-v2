FROM node:20-alpine AS base
WORKDIR /repo
RUN corepack disable

# --- deps stage: install once, cache aggressively ---
FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/base-framework/package.json packages/base-framework/
COPY services/llm-gateway/package.json services/llm-gateway/
RUN npm install --workspaces --include-workspace-root

# --- build stage: TS → JS ---
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/base-framework packages/base-framework
COPY services/llm-gateway services/llm-gateway
RUN npm run build --workspace @lcm/base-framework
RUN npm run build --workspace @lcm/llm-gateway

# --- runtime stage: minimal ---
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /repo /repo
WORKDIR /repo/services/llm-gateway
CMD ["node", "dist/main.js"]
