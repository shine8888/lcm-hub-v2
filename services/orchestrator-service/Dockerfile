FROM node:20-alpine AS base
WORKDIR /repo

FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/base-framework/package.json packages/base-framework/
COPY services/orchestrator-service/package.json services/orchestrator-service/
RUN npm install --workspaces --include-workspace-root

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/base-framework packages/base-framework
COPY services/orchestrator-service services/orchestrator-service
RUN npm run build --workspace @lcm/base-framework
RUN npm run build --workspace @lcm/orchestrator-service

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /repo /repo
WORKDIR /repo/services/orchestrator-service
CMD ["node", "dist/main.js"]
