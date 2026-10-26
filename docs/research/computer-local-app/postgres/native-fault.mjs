// Free native runtime proof: a real postgres.js client talks to an owned TCP blackhole.
// PATH is private to this process. No real docker executable is invoked.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDockerPostgres } from "../../../../packages/db/src/testing/docker-postgres.ts";

const fixture = await mkdtemp(join(tmpdir(), "nap-postgres-native-"));
const sockets = new Set();
let received;
const handshake = new Promise((resolve) => {
  received = resolve;
});
const server = createServer((socket) => {
  sockets.add(socket);
  socket.on("data", received);
  socket.on("error", () => {});
  socket.on("close", () => sockets.delete(socket));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
const previousPath = process.env.PATH;
process.env.PATH = `${fixture}:${previousPath}`;
process.env.NAP_PG_NATIVE = fixture;
process.env.NAP_PG_NATIVE_PORT = String(address.port);
const cli = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.NAP_PG_NATIVE;
const args = process.argv.slice(2);
const resource = path.join(root, 'resource');
fs.appendFileSync(path.join(root, 'events'), JSON.stringify(args)+'\\n');
if (args[0] === 'run') {
  fs.writeFileSync(resource,args[args.indexOf('--name')+1]); console.log('owned-native-id');
} else if (args[0] === 'port') console.log('127.0.0.1:'+process.env.NAP_PG_NATIVE_PORT);
else if (args[0] === 'rm') fs.rmSync(resource,{force:true});
else if (args[0] === 'container' && args[1] === 'ls') {
  if(fs.existsSync(resource)) console.log('owned-native-id');
} else process.exitCode=1;
`;
try {
  await writeFile(join(fixture, "docker"), cli, { mode: 0o755 });
  const controller = new AbortController();
  const startup = startDockerPostgres({ signal: controller.signal, timeoutMs: 2000 });
  const rejected = assert.rejects(startup, /native startup interrupted/);
  await Promise.race([handshake, startup]);
  const started = performance.now();
  controller.abort(new Error("native startup interrupted"));
  await rejected;
  assert.ok(performance.now() - started < 2000);
  await assert.rejects(readFile(join(fixture, "resource")), /ENOENT/);
  const events = (await readFile(join(fixture, "events"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  const name = events[0][events[0].indexOf("--name") + 1];
  assert.match(name, /^nap-postgres-[a-f0-9-]+$/);
  assert.deepEqual(events.at(-1), [
    "container",
    "ls",
    "--all",
    "--filter",
    `name=^/${name}$`,
    "--format",
    "{{.ID}}",
  ]);
  console.log(
    JSON.stringify({
      runtime: process.versions.bun ? "Bun" : "Node",
      version: process.versions.bun ?? process.version,
      case: "real postgres.js stalled startup",
      result: "PASS",
      elapsedMs: Math.round(performance.now() - started),
      openFixtureSockets: sockets.size,
    }),
  );
} finally {
  process.env.PATH = previousPath;
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  await rm(fixture, { recursive: true, force: true });
}
