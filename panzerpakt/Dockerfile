FROM node:20-alpine
WORKDIR /app
COPY server.js ./
COPY package.json ./
COPY public ./public
ENV NODE_ENV=production
CMD ["node", "server.js"]
