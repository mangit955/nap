/**
 * Drives the browser a verify-nap fixture started, one action per invocation.
 *
 * The fixture (`apps/api/scripts/verify-nap.ts`) owns the processes; this owns nothing. Each call
 * attaches to the fixture's Chrome over its DevTools port, acts on the page a user would be looking
 * at, prints what it found, and detaches — so a sign-in survives between calls and an agent can
 * read the page between actions. Targets are ARIA roles and accessible names, never selectors.
 *
 * Run: bun run verify-nap <command> [--run=<run directory>]
 * Commands and flags: `verify-nap-cli.ts`; recipes: `.agents/skills/verify-nap/`.
 */
import { execFileSync } from "node:child_process";
import { access, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ModelListSchema } from "@nap/shared/models-protocol";
import { chromium, type FrameLocator, type Locator, type Page } from "playwright-core";
import {
  type Command,
  chooseRun,
  evidenceName,
  FIXTURE_MARKER,
  type FoundRun,
  parseCommand,
  type RunFile,
  RunFileSchema,
  StartedFileSchema,
  type Target,
  ViewportSchema,
} from "./verify-nap-cli.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `pid` is still the process that was recorded, not one the OS has since reused: its
 * command line has to contain the marker recorded with it.
 */
function ours(pid: number, marker: string): boolean {
  if (!alive(pid)) return false;
  try {
    return execFileSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
    }).includes(marker);
  } catch {
    return false;
  }
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

async function readRun(directory: string): Promise<RunFile> {
  const raw = await readFile(join(directory, "run.json"), "utf8").catch(() => {
    throw new Error(`${directory} has no run.json: its fixture never became ready.`);
  });
  const parsed = RunFileSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error(`${directory}/run.json is not a verify-nap run file.`);
  return parsed.data;
}

async function readStarted(directory: string) {
  const raw = await readFile(join(directory, "started.json"), "utf8").catch(() => null);
  if (raw === null) return null;
  // A file that will not parse belongs to a run this command cannot act on; skipping it keeps a
  // broken run from failing every command meant for a healthy one.
  try {
    const parsed = StartedFileSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Every run directory that has not been cleaned up, as live (fixture up) or stale (it died). */
async function findRuns(): Promise<FoundRun[]> {
  const scratch = join(repositoryRoot, ".scratch");
  const found: FoundRun[] = [];
  for (const entry of await readdir(scratch).catch(() => [])) {
    if (!entry.startsWith("verify-nap-")) continue;
    const directory = join(scratch, entry);
    if (await exists(join(directory, "cleanup.json"))) continue;
    const started = await readStarted(directory);
    if (started === null) continue;
    const up = ours(started.pid, FIXTURE_MARKER);
    // A fixture still starting has no run.json yet and cannot be driven; leave it alone.
    if (up && !(await exists(join(directory, "run.json")))) continue;
    found.push({ directory, state: up ? "live" : "stale" });
  }
  return found;
}

/** The run named by --run or VERIFY_NAP_RUN, else the only one that fits the command. */
async function findRunDirectory(explicit: string | undefined, kind: Command["kind"]) {
  const named = explicit ?? process.env.VERIFY_NAP_RUN;
  if (named !== undefined) return resolve(named);
  const chosen = chooseRun(await findRuns(), kind);
  if (!chosen.ok) throw new Error(chosen.error);
  return chosen.value;
}

/**
 * Waits until React has hydrated the page. Before that the markup is there but inert: a value
 * filled into a textbox is wiped by hydration and a click submits the form natively, which on
 * a first, still-compiling `next dev` request is several seconds of a page that looks ready.
 * Next's root layout renders <body>, so a fiber on it means the tree is live.
 */
async function hydrated(page: Page) {
  await page.waitForLoadState("load");
  await page.waitForFunction(
    () => Object.keys(document.body).some((key) => key.startsWith("__reactFiber$")),
    undefined,
    { timeout: 120_000 },
  );
}

/**
 * Waits until the page has stopped moving: the same scroll position and viewport for ten frames
 * running, or five seconds at most. A viewport just set again repaints and reflows, and a page
 * opened at an anchor scrolls to it smoothly; evidence captured mid-way shows a frame the reader
 * never sees, with the "On this page" mark matching a scroll position the page is passing through.
 */
async function settled(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const state = () => `${scrollX},${scrollY},${innerWidth},${innerHeight}`;
        const start = performance.now();
        let last = state();
        let still = 0;
        const tick = () => {
          const now = state();
          still = now === last ? still + 1 : 0;
          last = now;
          if (still >= 10 || performance.now() - start > 5000) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
}

/**
 * The page, or the live iframe with this title. The preview pane can hold two frames with the
 * same title while one replaces the other; the outgoing one is aria-hidden, as it is to a reader.
 */
function scope(page: Page, frame: string | undefined): Page | FrameLocator {
  return frame === undefined
    ? page
    : page.frameLocator(`iframe[title=${JSON.stringify(frame)}]:not([aria-hidden="true"])`);
}

function locate(page: Page, target: Target): Locator {
  const within = scope(page, target.frame);
  return "text" in target
    ? within.getByText(target.text).first()
    : within.getByRole(target.role, { name: target.name, exact: target.exact });
}

function describe(target: Target): string {
  return "text" in target ? `text "${target.text}"` : `${target.role} "${target.name}"`;
}

async function capture(
  page: Page,
  run: RunFile,
  label: string,
  fullPage: boolean | null,
  frame?: string,
) {
  const name = evidenceName(await readdir(run.evidence), label);
  const aria = join(run.evidence, `${name}.aria.yml`);
  const where = frame === undefined ? "" : `# frame: ${frame}\n`;
  const header = `# ${label}\n# url: ${page.url()}\n${where}# at: ${new Date().toISOString()}\n`;
  await writeFile(aria, header + (await scope(page, frame).locator("body").ariaSnapshot()));
  const written = [aria];
  if (fullPage !== null) {
    const png = join(run.evidence, `${name}.png`);
    // Next's dev-mode badge is not part of the app, and would otherwise sit in every picture.
    await page.screenshot({
      path: png,
      fullPage,
      style: "nextjs-portal { display: none !important; }",
    });
    written.unshift(png);
  }
  return written;
}

/**
 * Signs in over HTTP and asks the API which models a turn may run on. The point of the fixture is
 * that nothing spends money, so this asks the running composition rather than trusting what the
 * fixture wrote about itself.
 */
async function offeredModels(run: RunFile): Promise<{ runnable: string[]; fixtureKey: boolean }> {
  const signedIn = await fetch(`${run.api}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { origin: run.web, "content-type": "application/json" },
    body: JSON.stringify({ email: run.email, password: run.password }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!signedIn.ok) throw new Error(`sign-in answered ${signedIn.status}`);
  const cookie = signedIn.headers
    .getSetCookie()
    .map((header) => header.split(";")[0])
    .join("; ");
  const listed = await fetch(`${run.api}/models`, {
    headers: { origin: run.web, cookie },
    signal: AbortSignal.timeout(5_000),
  });
  if (!listed.ok) throw new Error(`/models answered ${listed.status}`);
  const body = ModelListSchema.parse(await listed.json());
  // A line reachable means a key is saved, and the only one the fixture accepts is its made-up
  // one (`FIXTURE_KEY` in apps/api/scripts/verify-nap.ts), whose turns still run on the scripted
  // model. Under any other key its lines are counted, and fail the check.
  const fixtureKey = body.key.configured && body.key.hint === "sk-or-…FAKE";
  return {
    fixtureKey,
    runnable: [
      ...(body.free === null ? [] : [body.free.id]),
      ...(fixtureKey ? [] : body.lines.flatMap((line) => (line.available ? [line.key] : []))),
    ],
  };
}

async function doctor(run: RunFile): Promise<boolean> {
  const check = async (name: string, ok: () => Promise<boolean>) => {
    let passed = false;
    try {
      passed = await ok();
    } catch {
      passed = false;
    }
    console.log(`${passed ? "ok  " : "FAIL"} ${name}`);
    return passed;
  };
  const answers = (url: string) => async () =>
    (await fetch(url, { signal: AbortSignal.timeout(5_000) })).ok;
  const results = [
    await check(`fixture process ${run.pid} is running`, async () => ours(run.pid, FIXTURE_MARKER)),
    await check(`web app answers ${run.web}/sign-in`, answers(`${run.web}/sign-in`)),
    await check(`API answers ${run.api}/health`, answers(`${run.api}/health`)),
    await check(`previewed app answers ${run.preview}`, answers(run.preview)),
    await check(`Chrome DevTools answers ${run.cdp}`, answers(`${run.cdp}/json/version`)),
    await check("the API offers only scripted fake models (verify/*)", async () => {
      const { runnable, fixtureKey } = await offeredModels(run);
      return (
        (runnable.length > 0 || fixtureKey) && runnable.every((id) => id.startsWith("verify/"))
      );
    }),
  ];
  console.log(
    `run: ${run.runDirectory}\nevidence: ${run.evidence}\nstops by itself at: ${run.stopsAt}`,
  );
  return results.every(Boolean);
}

/**
 * Stops the fixture, which cleans up after itself. A fixture that died without doing so (killed,
 * or its session closed) left what `started.json` lists; those are removed here, each only after
 * its command line shows it is still the process that was recorded.
 */
async function stopRun(directory: string) {
  const started = await readStarted(directory);
  if (started === null) throw new Error(`${directory} has no started.json; nothing to stop.`);
  if (ours(started.pid, FIXTURE_MARKER)) {
    process.kill(started.pid, "SIGTERM");
    const deadline = Date.now() + 60_000;
    while (alive(started.pid) && Date.now() < deadline) await sleep(250);
    if (alive(started.pid)) throw new Error(`Fixture ${started.pid} did not stop within 60s.`);
  } else if (!(await exists(join(directory, "cleanup.json")))) {
    console.log(`Fixture ${started.pid} is gone without cleaning up; removing what it left.`);
    const failures: string[] = [];
    for (const child of started.processes) {
      if (!ours(child.pid, child.marker)) continue;
      process.kill(child.pid, "SIGTERM");
      const deadline = Date.now() + 10_000;
      while (alive(child.pid) && Date.now() < deadline) await sleep(250);
      if (alive(child.pid)) process.kill(child.pid, "SIGKILL");
    }
    if (started.container !== null) {
      try {
        execFileSync("docker", ["rm", "--force", started.container], { stdio: "ignore" });
      } catch {
        // Already gone (the container runs with --rm), or Docker is not answering. Either way the
        // folders below are still removed and cleanup.json still written.
        try {
          const left = execFileSync(
            "docker",
            ["ps", "-aq", "--filter", `name=^/${started.container}$`],
            { encoding: "utf8" },
          ).trim();
          if (left !== "") failures.push(`Postgres container ${started.container}`);
        } catch {
          failures.push(`Postgres container ${started.container} (Docker not answering)`);
        }
      }
    }
    // What the fixture's own cleanup deletes: the web copy with its dev build cache, and the
    // Chrome profile. Both live inside the run directory, so nothing else can own them.
    for (const scratch of ["web", "chrome-profile"]) {
      try {
        await rm(join(directory, scratch), { recursive: true, force: true });
      } catch {
        failures.push(`${scratch}/`);
      }
    }
    await writeFile(
      join(directory, "cleanup.json"),
      JSON.stringify(
        { ok: failures.length === 0, failures, recoveredBy: "verify-nap stop" },
        null,
        2,
      ),
    );
  }
  const cleanup = await readFile(join(directory, "cleanup.json"), "utf8").catch(
    () => "(no cleanup.json)",
  );
  const kept = await readdir(join(directory, "evidence")).catch(() => []);
  console.log(
    `cleanup: ${cleanup}\nevidence kept (${kept.length} files): ${join(directory, "evidence")}`,
  );
}

/**
 * The viewport `resize` chose, kept in the run directory. An emulated viewport belongs to the
 * DevTools connection that set it and lapses when a command detaches, and headless Chrome will not
 * size its window below 500 pixels, so a phone width is set again at the start of every command
 * (and the window is sized as close to it as Chrome allows, by `sizeWindow`).
 */
const VIEWPORT_FILE = "viewport.json";

/**
 * The window itself, which unlike the emulated viewport keeps its size after a command detaches.
 * Headless Chrome will not make it narrower than 500 pixels, so a phone width still needs the
 * emulation; but between two commands the page then sits at 500 rather than snapping back to the
 * fixture's 1440, which would cross every layout breakpoint in between and close anything a page
 * closes when the window widens (the docs' phone menu does).
 */
async function sizeWindow(page: Page, width: number, height: number) {
  const session = await page.context().newCDPSession(page);
  const { windowId } = await session.send("Browser.getWindowForTarget");
  await session.send("Browser.setWindowBounds", {
    windowId,
    bounds: { width: Math.max(width, MIN_WINDOW_WIDTH), height, windowState: "normal" },
  });
  await session.detach();
}

const MIN_WINDOW_WIDTH = 500;

async function applyViewport(page: Page, directory: string) {
  const raw = await readFile(join(directory, VIEWPORT_FILE), "utf8").catch(() => null);
  if (raw === null) return;
  let saved: unknown;
  try {
    saved = JSON.parse(raw);
  } catch {
    saved = null;
  }
  const viewport = ViewportSchema.safeParse(saved);
  if (!viewport.success) {
    throw new Error(`${VIEWPORT_FILE} is not a viewport; run resize again to replace it.`);
  }
  await page.setViewportSize(viewport.data);
  await settled(page);
}

async function act(page: Page, run: RunFile, command: Command) {
  switch (command.kind) {
    case "url":
      return;
    case "goto":
      await page.goto(`${run.web}${command.path}`);
      await hydrated(page);
      await settled(page);
      return;
    case "signin":
      await page.goto(`${run.web}/sign-in`);
      await hydrated(page);
      // A signed-in visitor is sent on from /sign-in after a session check, and the form shows
      // until it answers — so ask the same question first rather than racing the redirect.
      if (
        await page.evaluate(async (api) => {
          const response = await fetch(`${api}/api/auth/get-session`, { credentials: "include" });
          return response.ok && (await response.json()) !== null;
        }, run.api)
      ) {
        await page.goto(`${run.web}/dashboard`);
        await hydrated(page);
        console.log("already signed in");
        return;
      }
      await page.getByRole("textbox", { name: "Email", exact: true }).fill(run.email);
      await page.getByRole("textbox", { name: "Password", exact: true }).fill(run.password);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 60_000 });
      await hydrated(page);
      return;
    case "click":
      await hydrated(page);
      await locate(page, command.target).click({
        timeout: 15_000,
        button: command.right ? "right" : "left",
      });
      return;
    case "hover":
      await hydrated(page);
      await locate(page, command.target).hover({ timeout: 15_000 });
      return;
    case "fill":
      await hydrated(page);
      await locate(page, command.target).fill(command.value, { timeout: 15_000 });
      return;
    case "press":
      await page.keyboard.press(command.key);
      return;
    case "wait":
      await locate(page, command.target).waitFor({
        state: command.state,
        timeout: command.timeoutMs,
      });
      return;
    case "snapshot":
      console.log((await capture(page, run, command.label, null, command.frame)).join("\n"));
      console.log(await scope(page, command.frame).locator("body").ariaSnapshot());
      return;
    case "shot":
      await settled(page);
      console.log((await capture(page, run, command.label, command.fullPage)).join("\n"));
      return;
    case "resize":
      // Applied in `main` before every command, from the file it writes.
      console.log(`viewport ${command.width}×${command.height}`);
      return;
    case "doctor":
    case "stop":
      throw new Error(`${command.kind} does not use the browser`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const runFlag = args.find((arg) => arg.startsWith("--run="));
  const parsed = parseCommand(args.filter((arg) => arg !== runFlag));
  if (!parsed.ok) {
    console.error(parsed.error);
    process.exit(2);
  }
  const command = parsed.value;
  const directory = await findRunDirectory(runFlag?.slice("--run=".length), command.kind);
  if (command.kind === "stop") return stopRun(directory);
  const run = await readRun(directory);
  if (command.kind === "doctor") process.exit((await doctor(run)) ? 0 : 1);

  const browser = await chromium.connectOverCDP(run.cdp);
  try {
    const context = browser.contexts()[0];
    if (context === undefined) throw new Error("The fixture's Chrome has no browser context.");
    const page = context.pages()[0] ?? (await context.newPage());
    try {
      if (command.kind === "resize") {
        // Applied before it is saved, so a size Chrome refuses never reaches the commands after.
        await page.setViewportSize({ width: command.width, height: command.height });
        await sizeWindow(page, command.width, command.height);
        await settled(page);
        await writeFile(
          join(directory, VIEWPORT_FILE),
          JSON.stringify({ width: command.width, height: command.height }),
        );
      } else {
        await applyViewport(page, directory);
      }
      await act(page, run, command);
    } catch (error) {
      // A failed action is evidence too: save what the page looked like when it failed.
      const failed = await capture(page, run, `failed ${command.kind}`, false).catch(() => []);
      console.error(String(error));
      if (failed.length) console.error(`page at failure: ${failed.join(", ")}`);
      process.exitCode = 1;
    }
    console.log(`url: ${page.url()}`);
    if ("target" in command && process.exitCode !== 1)
      console.log(`ok: ${command.kind} ${describe(command.target)}`);
  } finally {
    // Detaches; the fixture's Chrome and its pages keep running for the next command.
    await browser.close();
  }
}

try {
  await main();
} catch (error) {
  // Every failure here is about the run (none started, one stopped, a bad run file), and the
  // message says what to do; a stack trace would bury it.
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
