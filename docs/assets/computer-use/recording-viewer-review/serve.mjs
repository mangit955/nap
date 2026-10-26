import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";

const require = createRequire(import.meta.url);
const { createServer } = await import(
  createRequire(require.resolve("@vitejs/plugin-react")).resolve("vite")
);
const root = fileURLToPath(new URL("./", import.meta.url));
const workspace = fileURLToPath(new URL("../../../..", import.meta.url));
const web = `${workspace}/apps/web`;
const server = await createServer({
  configFile: false,
  root,
  plugins: [react()],
  resolve: {
    alias: {
      "react-dom/client": require.resolve("react-dom/client", { paths: [web] }),
      "react-dom": require.resolve("react-dom", { paths: [web] }),
      "react/jsx-dev-runtime": require.resolve("react/jsx-dev-runtime", { paths: [web] }),
      "react/jsx-runtime": require.resolve("react/jsx-runtime", { paths: [web] }),
      react: require.resolve("react", { paths: [web] }),
    },
  },
  server: { host: "127.0.0.1", port: 4321, strictPort: true, fs: { allow: [workspace] } },
});
await server.listen();
server.printUrls();
