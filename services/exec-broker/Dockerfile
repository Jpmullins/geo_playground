FROM node:24-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-package-lock --loglevel=error
COPY server.mjs otel.mjs ./
EXPOSE 8081
CMD ["npm", "run", "start"]
