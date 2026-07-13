FROM node:24-alpine AS build

WORKDIR /app
COPY package.json ./
RUN npm install
COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src
RUN npm run build

FROM node:24-alpine
WORKDIR /app
# Runtime needs only the OTEL packages (server.mjs itself is dependency-free);
# otel.mjs degrades to a no-op if these are absent or the endpoint is unset.
RUN npm install --no-package-lock --loglevel=error \
    @opentelemetry/sdk-node@^0.220.0 \
    @opentelemetry/instrumentation-http@^0.220.0 \
    @opentelemetry/instrumentation-undici@^0.30.0 \
    @opentelemetry/exporter-trace-otlp-http@^0.220.0
COPY --from=build /app/dist ./dist
COPY server.mjs otel.mjs ./
EXPOSE 3000
CMD ["node", "--import", "./otel.mjs", "server.mjs"]
