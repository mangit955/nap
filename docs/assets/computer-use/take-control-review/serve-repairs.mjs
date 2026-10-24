// Serve the shipped fixture directly from source, without a production build.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";

const require = createRequire(import.meta.url);
const { createServer } = await import(
  require.resolve("vite", {
    paths: [dirname(require.resolve("vitest/package.json"))],
  })
);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const root = await mkdtemp(join(tmpdir(), "nap-control-repairs-"));
await writeFile(
  join(root, "index.html"),
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Input repair check</title></head><body><div id="root"></div><script type="module" src="/@fs/${repo}/apps/web/src/testing/take-control-review/main.tsx"></script></body></html>`,
);
const server = await createServer({
  configFile: false,
  root,
  plugins: [react()],
  resolve: {
    alias: {
      react: join(repo, "apps/web/node_modules/react"),
      "react-dom": join(repo, "apps/web/node_modules/react-dom"),
    },
  },
  publicDir: join(repo, "docs/assets/computer-use/panel-review"),
  define: { "process.env.NEXT_PUBLIC_API_URL": JSON.stringify("http://localhost:3001") },
  server: { host: "127.0.0.1", port: 4336, strictPort: true, fs: { allow: [repo, root] } },
});
await server.listen();
console.log("Current-source fixture: http://127.0.0.1:4336");
process.once("SIGINT", async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
  process.exit(0);
});
