FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile || bun install

# Copy source
COPY . .

RUN chown -R bun:bun /app
USER bun

# Runtime
ENV NODE_ENV=production
EXPOSE 9090
CMD ["bun", "run", "src/index.ts"]