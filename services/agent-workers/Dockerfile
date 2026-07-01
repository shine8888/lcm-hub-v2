FROM node:20-alpine AS base
WORKDIR /repo

FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/base-framework/package.json packages/base-framework/
COPY services/agent-workers/package.json services/agent-workers/
RUN npm install --workspaces --include-workspace-root

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/base-framework packages/base-framework
COPY services/agent-workers services/agent-workers
RUN npm run build --workspace @lcm/base-framework
RUN npm run build --workspace @lcm/agent-workers

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /repo /repo
WORKDIR /repo/services/agent-workers
CMD ["node", "dist/main.js"]
