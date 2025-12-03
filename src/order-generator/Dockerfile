FROM node:18-alpine

WORKDIR /app

COPY order-generator/package*.json ./
RUN npm install --production

COPY order-generator/index.js ./

CMD ["node", "index.js"]
