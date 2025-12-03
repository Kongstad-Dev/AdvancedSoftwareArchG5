FROM node:18-alpine

WORKDIR /app

COPY dashboard/package.json ./
RUN npm install --production

COPY dashboard/server.js ./
COPY dashboard/public ./public

EXPOSE 8080

CMD ["node", "server.js"]
