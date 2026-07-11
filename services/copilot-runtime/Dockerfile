FROM node:24-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.mjs ./
COPY otel.mjs ./

EXPOSE 8091
CMD ["node", "--import", "./otel.mjs", "server.mjs"]

