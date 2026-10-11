FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src

RUN mkdir -p /app/data/auth

ENV NODE_ENV=production
ENV WHATSAPP_AUTH_PATH=/app/data/auth

EXPOSE 8082

CMD ["node", "src/server.js"]
