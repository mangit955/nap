import type { NextConfig } from "next";

const config: NextConfig = {
  // Workspace packages resolve to raw TypeScript source (`"exports": { "./*": "./src/*.ts" }`
  // — there is no build step), so Next has to compile them rather than treat them as
  // published JavaScript.
  transpilePackages: ["@nap/shared"],
  // Types are the business of `bun run typecheck`, which covers the whole workspace and
  // runs in CI. Letting `next build` run its own copy would mean two sources of truth that
  // can disagree, and a slower build for no new signal. (Next 16 no longer takes an
  // `eslint` key at all — Biome is the linter here regardless.)
  typescript: { ignoreBuildErrors: true },
};

export default config;
