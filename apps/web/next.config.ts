import type { NextConfig } from "next";

const config: NextConfig = {
  // Types are the business of `bun run typecheck`, which covers the whole workspace and
  // runs in CI. Letting `next build` run its own copy would mean two sources of truth that
  // can disagree, and a slower build for no new signal. (Next 16 no longer takes an
  // `eslint` key at all — Biome is the linter here regardless.)
  typescript: { ignoreBuildErrors: true },
};

export default config;
