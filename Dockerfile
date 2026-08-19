FROM node:24-alpine

WORKDIR /app

COPY package.json ./

RUN npm install --omit=dev

COPY server.js ./

EXPOSE 10000

CMD ["npm", "start"]
