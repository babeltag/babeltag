# Babeltag — one dependency, so the image stays small.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY README.md ./

# Mount your library at /music.
VOLUME ["/music"]
ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["--help"]
