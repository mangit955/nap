/** Free real-Bun probe. --default deliberately restores the failing HTTP idle default. */
import assert from "node:assert/strict";
import { HTTP_SERVER_OPTIONS } from "../src/http-options.ts";

assert(process.argv[2] === undefined || process.argv[2] === "--default");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  ...(process.argv[2] === "--default" ? {} : HTTP_SERVER_OPTIONS),
  async fetch() {
    await Bun.sleep(15_000);
    return new Response("desktop-ready-fixture");
  },
});
try {
  const client = Bun.spawn(
    [
      "curl",
      "--fail",
      "--silent",
      "--show-error",
      "--max-time",
      "20",
      `http://127.0.0.1:${server.port}`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [code, body, error] = await Promise.all([
    client.exited,
    new Response(client.stdout).text(),
    new Response(client.stderr).text(),
  ]);
  assert.equal(code, 0, error);
  assert.equal(body, "desktop-ready-fixture");
  console.log("PASS: the actual Bun HTTP listener retains a delayed desktop response.");
} finally {
  await server.stop(true);
}
