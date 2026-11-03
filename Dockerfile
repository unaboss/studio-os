# Studio OS: the API, the agent's scheduler and the built web app, in one image.
FROM node:22-slim AS build
WORKDIR /app
COPY . .
RUN npm ci && npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app /app
# The folder shared with the sandbox container. Owned by node so both sides can use it.
RUN mkdir -p /jobs && chown node:node /jobs
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node_modules/.bin/tsx", "apps/api/src/server.ts"]
