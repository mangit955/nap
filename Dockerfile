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

# The whole workspace, because the API imports eight sibling packages by source and a
# per-package copy would be a list to forget to update.
COPY . .

# `--ignore-scripts` is load-bearing: the root `prepare` script runs `lefthook install`, which
# needs a git repository and a git hooks directory. Neither exists in an image, so without
# this the install fails outright. Nothing installed here has a postinstall step that matters
# at runtime — puppeteer-core downloads no browser, and this image deliberately has none.
RUN bun install --frozen-lockfile --ignore-scripts

# Devdependencies come along for the ride. Pruning them would save a little space and risk
# rather more: `drizzle-orm` is a devDependency of the API and is very much used at runtime.

# PORT comes from the platform; env.ts coerces it and defaults to 3001 when nothing sets it.
EXPOSE 3001

# Not `bun run dev` — that is `--watch`, which is a filesystem watcher on a read-only image
# and a second process to no purpose.
CMD ["bun", "apps/api/src/index.ts"]
