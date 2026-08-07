import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
