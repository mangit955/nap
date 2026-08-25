import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Must stay in step with the `paths` entry in tsconfig.json: TypeScript resolves imports
  // for the editor and `bun run typecheck`, Vite resolves them for the bundle, and neither
  // reads the other's config.
  // `new URL` rather than `node:path`: this file is typechecked with only `vite/client` in
  // `types`, so reaching for a Node builtin here fails `bun run typecheck` inside the sandbox.
  resolve: {
    alias: { "@": new URL("./src", import.meta.url).pathname },
  },
  server: {
    // The dev server runs inside a sandbox and is reached through a public proxy
    // rather than over localhost, so it has to listen on every interface and accept
    // the forwarded host.
    host: true,
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    // Containers do not reliably deliver filesystem events to the watcher, so an
    // agent writing a file would otherwise not trigger a reload.
    watch: { usePolling: true },
  },
});
