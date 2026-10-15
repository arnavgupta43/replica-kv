# One image for every service. docker-compose.yml picks which server each container runs.
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

CMD ["node", "src/replica/server.js"]
