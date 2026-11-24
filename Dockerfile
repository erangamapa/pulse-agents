# Build from the directory that holds all three sibling repos.
#   docker build -f pulse-agents/Dockerfile -t pulse-agents .
FROM node:22-slim AS build
WORKDIR /workspace

COPY sportsbook-contracts/packages/ts ./sportsbook-contracts/packages/ts
RUN cd sportsbook-contracts/packages/ts && npm ci && npm run build

COPY agentloop ./agentloop
RUN cd agentloop && npm ci && npm run build

COPY pulse-agents ./pulse-agents
WORKDIR /workspace/pulse-agents
RUN npm install --install-links && npx tsc -p tsconfig.build.json && npm prune --omit=dev

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /workspace/pulse-agents/node_modules ./node_modules
COPY --from=build /workspace/pulse-agents/dist ./dist
COPY --from=build /workspace/pulse-agents/package.json ./package.json
RUN groupadd --system app && useradd --system --gid app --no-create-home app
USER app
EXPOSE 8080
CMD ["node", "dist/index.js"]
