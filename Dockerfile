FROM node:20-alpine AS builder

RUN apk add --no-cache git

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .
RUN npm run build

# ---

FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

COPY --from=builder /app/build ./build
COPY --from=builder /app/package.json ./package.json
RUN npm install --omit=dev

EXPOSE 3000

CMD ["node", "build/index.js"]
