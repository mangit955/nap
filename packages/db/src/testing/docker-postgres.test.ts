import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { portFrom, startDockerPostgres } from "./docker-postgres.ts";

describe("portFrom", () => {
  it("reads the published port off a single mapping", () => {
    expect(portFrom("0.0.0.0:55003\n")).toBe(55003);
  });

  it("reads it when docker also published the mapping on IPv6", () => {
    // Two lines is the ordinary output on a machine with both stacks, and both name the same
    // port — so taking the last is as good as taking the first, and neither may throw.
    expect(portFrom("0.0.0.0:55003\n[::]:55003\n")).toBe(55003);
  });

  it("says what it could not read rather than handing back a NaN port", () => {
    expect(() => portFrom("")).toThrow(/could not read a published port/);
  });
});

// Keep Testcontainers out of this process: the helper must also load under Bun.
vi.mock("./postgres-container.ts", () => ({
  POSTGRES_IMAGE: "postgres:17-alpine",
  MIGRATIONS_FOLDER: "unused-by-sql-stub",
}));

const sql = vi.hoisted(() => ({
  query: vi.fn(async () => []),
  end: vi.fn(async (_options?: { timeout?: number }) => {}),
  migrate: vi.fn(async () => {}),
}));
vi.mock("postgres", () => ({ default: () => Object.assign(sql.query, { end: sql.end }) }));
vi.mock("drizzle-orm/postgres-js", () => ({ drizzle: (client: unknown) => client }));
vi.mock("drizzle-orm/postgres-js/migrator", () => ({ migrate: sql.migrate }));

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// A real CLI process, never a real Docker command. Its resource file represents exactly one
// allocation, including an allocation made before `run` has printed its ID.
const dockerStub = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.NAP_PG_FIXTURE;
const args = process.argv.slice(2);
const command = args[0];
fs.appendFileSync(path.join(dir, 'events'), JSON.stringify({args, pid:process.pid})+'\\n');
const mode = fs.readFileSync(path.join(dir,'mode'),'utf8');
const resource = path.join(dir,'resource');
const name = args[args.indexOf('--name')+1] || 'legacy';
function hang() { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
if (command === 'run') {
  fs.writeFileSync(resource,name);
  if (mode === 'run-hang') hang(); else console.log('owned-id');
} else if (command === 'port') {
  if (mode === 'port-hang') hang();
  else if (mode.includes('bad-port')) console.log('invalid mapping');
  else console.log('127.0.0.1:55003');
} else if (command === 'rm') {
  if (mode.includes('rm-hang')) hang();
  else if (mode.includes('rm-fail')) { console.error('daemon unavailable'); process.exitCode=1; }
  else { fs.rmSync(resource,{force:true}); console.log('owned-id'); }
} else if (command === 'container' && args[1] === 'ls') {
  if (mode.includes('verify-fail')) { console.error('daemon unavailable'); process.exitCode=1; }
  else if (fs.existsSync(resource)) console.log('owned-id');
} else { console.error('unexpected docker arguments'); process.exitCode=1; }
`;

describe("startDockerPostgres", () => {
  let fixture: string;
  let pending: Promise<unknown>[];

  beforeEach(async () => {
    fixture = await mkdtemp(join(tmpdir(), "nap-postgres-test-"));
    pending = [];
    await writeFile(join(fixture, "docker"), dockerStub, { mode: 0o755 });
    await writeFile(join(fixture, "mode"), "run-hang");
    await writeFile(join(fixture, "events"), "");
    vi.stubEnv("PATH", `${fixture}:${process.env.PATH}`);
    vi.stubEnv("NAP_PG_FIXTURE", fixture);
    sql.query.mockReset().mockResolvedValue([]);
    sql.end.mockReset().mockResolvedValue(undefined);
    sql.migrate.mockReset().mockResolvedValue(undefined);
  });

  async function events() {
    const lines = (await readFile(join(fixture, "events"), "utf8")).trim();
    return lines
      ? lines.split("\n").map((line): { args: string[]; pid: number } => JSON.parse(line))
      : [];
  }

  async function waitFor(command: string) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const found = (await events()).find((event) => event.args[0] === command);
      if (found) return found;
      await delay(10);
    }
    throw new Error(`stub did not receive ${command}`);
  }

  function start(options?: { signal?: AbortSignal; timeoutMs?: number }) {
    // Reflect.apply permits the regression to execute against the old no-argument signature.
    const promise: ReturnType<typeof startDockerPostgres> = Reflect.apply(
      startDockerPostgres,
      undefined,
      [options],
    );
    pending.push(promise.catch(() => {}));
    return promise;
  }

  async function failure(promise: Promise<unknown>, boundMs = 2500) {
    return Promise.race([
      promise.then(
        () => "unexpected startup success",
        (error: unknown) => String(error),
      ),
      delay(boundMs).then(() => "startup did not settle within test bound"),
    ]);
  }

  afterEach(async () => {
    // Also clean the fixture's real processes when running against the broken implementation.
    for (const event of await events()) {
      try {
        process.kill(event.pid, "SIGKILL");
      } catch {}
    }
    await Promise.race([Promise.allSettled(pending), delay(500)]);
    vi.unstubAllEnvs();
    await rm(fixture, { recursive: true, force: true });
  });

  it("aborts an allocating CLI, drains it, and rolls back by its pre-known owned name", async () => {
    const controller = new AbortController();
    const startup = start({ signal: controller.signal, timeoutMs: 10_000 });
    const allocating = await waitFor("run");
    controller.abort(new Error("startup interrupted"));
    expect(await failure(startup)).toContain("startup interrupted");
    expect(() => process.kill(allocating.pid, 0)).toThrow();
    const calls = await events();
    const name = allocating.args[allocating.args.indexOf("--name") + 1];
    expect(name).toMatch(/^nap-postgres-[a-f0-9-]+$/);
    expect(
      calls.some((call) => call.args.includes(name ?? "missing-name") && call.args[0] === "rm"),
    ).toBe(true);
    expect(calls.some((call) => call.args[0] === "container")).toBe(true);
    await expect(readFile(join(fixture, "resource"))).rejects.toThrow(/ENOENT/);
  });

  it("surfaces rollback failure with the owned name instead of hiding a leaked allocation", async () => {
    await writeFile(join(fixture, "mode"), "bad-port,rm-fail");
    expect(await failure(start())).toMatch(/cleanup failed.*nap-postgres-/);
    expect(await readFile(join(fixture, "resource"), "utf8")).toMatch(/^nap-postgres-/);
  });

  it.each(["run-hang", "port-hang"])(
    "bounds %s within the startup budget and drains the process",
    async (mode) => {
      await writeFile(join(fixture, "mode"), mode);
      expect(await failure(start({ timeoutMs: 800 }))).toContain("timed out after 800ms");
      const calls = await events();
      const blocked = calls.find(
        (event) => event.args[0] === (mode === "run-hang" ? "run" : "port"),
      );
      expect(blocked).toBeDefined();
      expect(() => process.kill(blocked!.pid, 0)).toThrow();
      await expect(readFile(join(fixture, "resource"))).rejects.toThrow(/ENOENT/);
    },
  );

  it.each(["query", "migrate"] as const)(
    "interrupts stalled %s and drains SQL before rollback",
    async (stage) => {
      await writeFile(join(fixture, "mode"), "ready");
      let entered!: () => void;
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let terminate!: (error: Error) => void;
      sql[stage].mockImplementationOnce(() => {
        entered();
        return new Promise<never>((_resolve, reject) => {
          terminate = reject;
        });
      });
      sql.end.mockImplementationOnce(async () => {
        terminate(new Error("CONNECTION_DESTROYED"));
      });
      const controller = new AbortController();
      const startup = start({ signal: controller.signal, timeoutMs: 5000 });
      await reached;
      controller.abort(new Error("cancel SQL startup"));
      expect(await failure(startup)).toContain("cancel SQL startup");
      expect(sql.end).toHaveBeenCalledWith({ timeout: 0 });
      if (stage === "query") expect(sql.migrate).not.toHaveBeenCalled();
      await expect(readFile(join(fixture, "resource"))).rejects.toThrow(/ENOENT/);
    },
  );

  it("includes migrations in the single startup deadline", async () => {
    await writeFile(join(fixture, "mode"), "ready");
    let terminate!: (error: Error) => void;
    sql.migrate.mockImplementationOnce(
      () =>
        new Promise<never>((_resolve, reject) => {
          terminate = reject;
        }),
    );
    sql.end.mockImplementationOnce(async () => {
      terminate(new Error("CONNECTION_DESTROYED"));
    });
    expect(await failure(start({ timeoutMs: 800 }))).toContain("timed out after 800ms");
    expect(sql.migrate).toHaveBeenCalledOnce();
    await expect(readFile(join(fixture, "resource"))).rejects.toThrow(/ENOENT/);
  });

  it("keeps no-options callers working and coalesces repeated stop with verified absence", async () => {
    await writeFile(join(fixture, "mode"), "ready");
    const database = await start();
    expect(database.url).toBe("postgres://postgres:nap-loadgen@127.0.0.1:55003/postgres");
    expect(sql.migrate).toHaveBeenCalledOnce();
    await Promise.all([database.stop(), database.stop()]);
    await database.stop();
    const calls = await events();
    expect(calls.filter((call) => call.args[0] === "rm")).toHaveLength(1);
    expect(calls.find((call) => call.args[0] === "container")?.args).toEqual([
      "container",
      "ls",
      "--all",
      "--filter",
      `name=^/${calls[0]!.args[calls[0]!.args.indexOf("--name") + 1]}$`,
      "--format",
      "{{.ID}}",
    ]);
    await expect(readFile(join(fixture, "resource"))).rejects.toThrow(/ENOENT/);
  });

  it("reports an unverifiable cleanup and permits retry after recovery", async () => {
    await writeFile(join(fixture, "mode"), "ready");
    const database = await start();
    await writeFile(join(fixture, "mode"), "verify-fail");
    await expect(database.stop()).rejects.toThrow(/daemon unavailable/);
    await writeFile(join(fixture, "mode"), "ready");
    await database.stop();
    await expect(readFile(join(fixture, "resource"))).rejects.toThrow(/ENOENT/);
  });

  it("bounds rollback independently when removal hangs", async () => {
    await writeFile(join(fixture, "mode"), "bad-port,rm-hang");
    expect(await failure(start(), 4000)).toMatch(/cleanup failed.*left owned container/);
    const blocked = (await events()).find((event) => event.args[0] === "rm");
    expect(blocked).toBeDefined();
    expect(() => process.kill(blocked!.pid, 0)).toThrow();
  });

  it("does not allocate for a pre-aborted caller", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already stopped"));
    expect(await failure(start({ signal: controller.signal }))).toContain("already stopped");
    expect(await events()).toEqual([]);
  });
});
