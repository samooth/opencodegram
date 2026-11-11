FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
COPY package.json bun.lockb* bun.lock* ./
RUN bun install --frozen-lockfile || bun install

# Copy source
COPY . .

RUN mkdir -p /app/data && chown -R bun:bun /app /app/data
USER bun

# Runtime
ENV NODE_ENV=production
EXPOSE 9090
CMD ["bun", "run", "src/index.ts"]