FROM node:24-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl g++ make python3 \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://ollama.com/install.sh | sh

WORKDIR /app
RUN mkdir -p /app/data

COPY package.json package-lock.json ./
RUN npm ci --production

COPY src ./src
COPY tsconfig.json ./tsconfig.json
COPY scripts/docker-entrypoint.sh ./scripts/docker-entrypoint.sh

ENV NODE_ENV=production
ENV OLLAMA_HOST=http://localhost:11434

CMD ["sh", "scripts/docker-entrypoint.sh"]
