import { defineConfig } from "drizzle-kit";

// Only `generate` is run from here, which needs no database connection — migrations are
// applied by drizzle-orm's `migrate()` (in tests, and later by the API), not by drizzle-kit.
// That keeps the generated SQL committed and reviewable rather than materialising at run time.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
});
