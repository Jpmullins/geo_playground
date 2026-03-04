FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY server.mjs ./
EXPOSE 8082
CMD ["npm", "run", "start"]
