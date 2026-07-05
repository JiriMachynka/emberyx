# Build the Astro static site from the monorepo root (build context = repo root)
FROM oven/bun:1.3.13 AS build
WORKDIR /app

# Install workspace deps against the root lockfile
COPY package.json bun.lock turbo.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/desktop/package.json apps/desktop/package.json
RUN bun install --frozen-lockfile

# Build only the web app
COPY . .
RUN bun run build --filter=@emberyx/web

# Serve the static output with nginx
FROM nginx:alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
