import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, posix } from "node:path";

const appRoot = "/home/user/app";
const maxBytes = 16_000_000;

function reply(value) {
  process.stdout.write(JSON.stringify(value));
}

function requestedPath(encoded) {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("invalid_path");
  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
  const normalized = posix.normalize(decoded);
  if (normalized !== appRoot && !normalized.startsWith(`${appRoot}/`)) {
    throw new Error("invalid_path");
  }
  return normalized;
}

async function nearestExisting(path) {
  let candidate = path;
  while (candidate !== appRoot) {
    try {
      await lstat(candidate);
      return candidate;
    } catch {
      candidate = dirname(candidate);
    }
  }
  return appRoot;
}

async function confined(path, allowMissing) {
  const existing = allowMissing ? await nearestExisting(path) : path;
  const resolved = await realpath(existing);
  if (resolved !== appRoot && !resolved.startsWith(`${appRoot}/`)) throw new Error("invalid_path");
}

async function readInput() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw new Error("too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function main() {
  const operation = process.argv[2] ?? "";
  const encoded = process.argv[3] ?? "";
  if (operation === "exec-result") {
    if (!/^[0-9a-f-]{36}$/.test(encoded)) throw new Error("invalid_operation");
    const path = `/tmp/nap-exec-results/${encoded}.json`;
    try {
      const chunks = [];
      for await (const chunk of createReadStream(path)) chunks.push(chunk);
      await rm(path, { force: true });
      reply({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    } catch {
      reply({ ok: false, code: "unavailable" });
    }
    return;
  }

  const path = requestedPath(encoded);
  if (operation === "write") {
    await confined(path, true);
    const bytes = await readInput();
    await mkdir(dirname(path), { recursive: true });
    await confined(dirname(path), false);
    const temporary = `${path}.nap-${process.pid}.tmp`;
    await new Promise((resolve, reject) => {
      const stream = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
      stream.once("error", reject);
      stream.end(bytes, resolve);
    });
    await rename(temporary, path);
    reply({ ok: true, value: null });
    return;
  }
  if (operation === "read") {
    await confined(path, false);
    const stat = await lstat(path);
    if (!stat.isFile()) throw new Error("file_not_found");
    if (stat.size > maxBytes) throw new Error("too_large");
    const chunks = [];
    for await (const chunk of createReadStream(path)) chunks.push(chunk);
    reply({ ok: true, value: Buffer.concat(chunks).toString("base64") });
    return;
  }
  if (operation === "list") {
    await confined(path, false);
    const entries = await readdir(path, { withFileTypes: true });
    reply({
      ok: true,
      value: entries
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((entry) => ({
          path: posix.join(path, entry.name),
          type: entry.isDirectory() ? "directory" : "file",
        })),
    });
    return;
  }
  throw new Error("invalid_operation");
}

main().catch((error) => {
  const code =
    (error instanceof Error && error.message === "file_not_found") ||
    (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      ? "file_not_found"
      : "exec_failed";
  reply({ ok: false, code });
});
