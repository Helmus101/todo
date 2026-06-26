# Single-service deploy: build the client, then run the Express server (which serves dist/ + the API).
FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=8788
EXPOSE 8788
CMD ["npm", "start"]
