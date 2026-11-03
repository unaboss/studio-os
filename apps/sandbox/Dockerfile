FROM node:22-alpine
WORKDIR /sandbox
COPY runner.mjs run-one.mjs ./
RUN mkdir -p /jobs && chown node:node /jobs
USER node
CMD ["node", "runner.mjs"]
