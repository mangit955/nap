# The API, as Railway runs it.
#
# There is no build step: every workspace package exports raw TypeScript ("./*": "./src/*.ts"),
# which Bun runs directly. So this image is the repository plus its dependencies, and the
# thing that would break a compiled deployment — a stale `dist` — cannot happen here.
#
# The web app is not in this image. It is served by Vercel from `apps/web`, and the two find
# each other through NAP_WEB_ORIGIN and NEXT_PUBLIC_API_URL. See docs/DEPLOY.md.
FROM oven/bun:1.3.13-slim

WORKDIR /app

# Chromium, so finished turns get photographed and the dashboard's cards are pictures of real
# apps rather than a colour hashed from the project id.
#
# Debian's `chromium` rather than a download: `puppeteer-core` ships no browser on purpose (see
# packages/capture), and apt gives us one that is patched by somebody else and comes with the
# shared libraries it needs already resolved. `fonts-liberation` is not optional decoration —
# without any font at all every screenshot is a page of empty boxes, which looks precisely like
# a broken app.
#
# Before `COPY . .` so a code change does not reinstall a browser on every deploy.
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

# Set here rather than as a platform variable, because the binary and the path to it are two
# halves of one fact and this image is where both live. A Railway variable could drift from the
# image that has to satisfy it; this cannot.
ENV NAP_CHROME_PATH=/usr/bin/chromium

# The whole workspace, because the API imports eight sibling packages by source and a
# per-package copy would be a list to forget to update.
COPY . .

# `--ignore-scripts` is load-bearing: the root `prepare` script runs `lefthook install`, which
# needs a git repository and a git hooks directory. Neither exists in an image, so without
# this the install fails outright. Nothing installed here has a postinstall step that matters
# at runtime — puppeteer-core downloads no browser, and the one this image has came from apt
# above, so nothing needs a second copy.
RUN bun install --frozen-lockfile --ignore-scripts

# Devdependencies come along for the ride. Pruning them would save a little space and risk
# rather more: `drizzle-orm` is a devDependency of the API and is very much used at runtime.

# PORT comes from the platform; env.ts coerces it and defaults to 3001 when nothing sets it.
EXPOSE 3001

# Not `bun run dev` — that is `--watch`, which is a filesystem watcher on a read-only image
# and a second process to no purpose.
CMD ["bun", "apps/api/src/index.ts"]
