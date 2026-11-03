FROM node:22-alpine
WORKDIR /sandbox
COPY runner.mjs run-one.mjs ./
USER node
CMD ["node", "runner.mjs"]
