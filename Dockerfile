# Single-service deploy: build the client, then run the Express server (which serves dist/ + the API).
FROM node:22-slim
WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787
CMD ["npm", "start"]
