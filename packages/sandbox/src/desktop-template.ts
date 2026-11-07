import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Result } from "@nap/shared/result";
import { Template, type TemplateClass, waitForPort } from "e2b";
import { z } from "zod";
import { DESKTOP_BUILD } from "./desktop-build.ts";
import { DESKTOP_BUILD_FILE, DESKTOP_DRIVER } from "./desktop-protocol.ts";
import { NAP_TEMPLATE, TEMPLATE_DEV_PORT, TEMPLATE_WORKDIR } from "./template.ts";

export const DESKTOP_INSTALL_COMMAND =
  "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y python3 libx11-6 libxtst6 xvfb x11-utils openbox xdotool ffmpeg x11vnc websockify novnc dbus-x11 fonts-liberation ca-certificates wget openssl util-linux && wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -O /tmp/nap-chrome.deb && apt-get install -y /tmp/nap-chrome.deb && rm /tmp/nap-chrome.deb && mkdir -p /etc/opt/chrome/policies/managed && chown user:user /etc/opt/chrome/policies/managed";
/**
 * The desktop machine's memory. One GiB peaked at 915 of the 976 MiB the guest sees on a small
 * app, with Vite, Chrome and the recorder running: docs/computer-use.md, "Verified on a VM".
 */
export const DESKTOP_MEMORY_MB = 2048;
const ManifestSchema = z.strictObject({
  version: z.literal(1),
  template: z.literal(NAP_TEMPLATE),
  cpuCount: z.literal(2),
  memoryMB: z.literal(DESKTOP_MEMORY_MB),
  files: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
});
export type DesktopTemplateManifest = z.infer<typeof ManifestSchema>;
type Prepared = Result<DesktopTemplateManifest, { message: string }>;
const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const repositoryDirectory = join(packageDirectory, "../..");
/**
 * Every file the desktop image runs, repository-relative: the start script and each local
 * module the driver bundle inlines, which a test holds this list to. Sources rather than the
 * bundle, because the bundle's bytes depend on the Bun version that built it.
 */
export const DESKTOP_SOURCES = [
  "packages/sandbox/desktop/start-desktop.sh",
  "packages/sandbox/scripts/desktop-driver.ts",
  "packages/sandbox/src/desktop-cdp-bridge.ts",
  "packages/sandbox/src/desktop-cdp.ts",
  "packages/sandbox/src/desktop-input.ts",
  "packages/sandbox/src/desktop-operations.ts",
  "packages/sandbox/src/desktop-process.ts",
  "packages/sandbox/src/desktop-protocol.ts",
  "packages/sandbox/src/desktop-recorder.ts",
  "packages/sandbox/src/desktop-release.ts",
  "packages/sandbox/src/desktop-scopes.ts",
  "packages/shared/src/ports/desktop-input-transport.ts",
  "packages/shared/src/ports/sandbox-desktop.ts",
] as const;
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
/** The build a desktop made from these sources reports. See `DESKTOP_BUILD`. */
export function desktopBuild(options: { root?: string; installCommand?: string } = {}): string {
  const root = options.root ?? repositoryDirectory;
  const lines = [`install ${sha256(options.installCommand ?? DESKTOP_INSTALL_COMMAND)}`];
  for (const path of DESKTOP_SOURCES)
    lines.push(`${path} ${sha256(readFileSync(join(root, path)))}`);
  return sha256(`${lines.join("\n")}\n`);
}
function files(directory: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = join(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Prepared template contains a symbolic link.");
      if (entry.isDirectory()) walk(full);
      else {
        const name = relative(directory, full).split(sep).join("/");
        if (name !== "manifest.json")
          entries[name] = createHash("sha256").update(readFileSync(full)).digest("hex");
      }
    }
  };
  walk(directory);
  return entries;
}
/** Builds reviewable local assets only. No E2B client or credential is used. */
export function prepareDesktopTemplate(options: {
  directory: string;
  sourceDirectory?: string;
}): Prepared {
  try {
    if (existsSync(options.directory) && readdirSync(options.directory).length)
      return { ok: false, error: { message: "Preparation directory must be empty." } };
    mkdirSync(join(options.directory, "desktop"), { recursive: true });
    cpSync(
      options.sourceDirectory ?? join(packageDirectory, "template"),
      join(options.directory, "app"),
      {
        recursive: true,
        filter: (source) => {
          const name = basename(source);
          return (
            !["node_modules", ".git", "dist", ".DS_Store"].includes(name) &&
            (!name.startsWith(".env") || name === ".env.example")
          );
        },
      },
    );
    cpSync(
      join(packageDirectory, "desktop/start-desktop.sh"),
      join(options.directory, "desktop/start-desktop.sh"),
    );
    chmodSync(join(options.directory, "desktop/start-desktop.sh"), 0o755);
    const bundle = spawnSync(
      "bun",
      [
        "build",
        join(packageDirectory, "scripts/desktop-driver.ts"),
        "--target=node",
        "--format=esm",
        `--outfile=${join(options.directory, "desktop/driver.mjs")}`,
      ],
      { encoding: "utf8" },
    );
    if (bundle.status !== 0)
      return { ok: false, error: { message: "Desktop driver bundling failed." } };
    writeFileSync(join(options.directory, "desktop/build"), `${desktopBuild()}\n`);
    const manifest: DesktopTemplateManifest = {
      version: 1,
      template: NAP_TEMPLATE,
      cpuCount: 2,
      memoryMB: DESKTOP_MEMORY_MB,
      files: files(options.directory),
    };
    writeFileSync(join(options.directory, "manifest.json"), JSON.stringify(manifest, null, 2));
    return { ok: true, value: manifest };
  } catch {
    return { ok: false, error: { message: "Could not prepare the desktop template." } };
  }
}
/** Refuses missing, modified or additional assets before any remote publication. */
export function validateDesktopTemplate(directory: string): Prepared {
  try {
    const manifest = ManifestSchema.parse(
      JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")),
    );
    const actual = files(directory);
    if (
      Object.keys(actual).length !== Object.keys(manifest.files).length ||
      Object.entries(manifest.files).some(([name, hash]) => actual[name] !== hash)
    )
      return {
        ok: false,
        error: { message: "Prepared template assets changed. Prepare and review them again." },
      };
    // Published, a build other than DESKTOP_BUILD would be refused by the runtime deployed
    // from this checkout: computer use would be unavailable in every new project.
    if (readFileSync(join(directory, "desktop/build"), "utf8") !== `${DESKTOP_BUILD}\n`)
      return {
        ok: false,
        error: {
          message:
            "Prepared desktop build is not this checkout's DESKTOP_BUILD. Prepare it again from the commit being deployed.",
        },
      };
    return { ok: true, value: manifest };
  } catch {
    return {
      ok: false,
      error: { message: "Prepared template manifest is unavailable or invalid." },
    };
  }
}

/** The image a validated prepared directory publishes. Building it is the paid step. */
export function desktopTemplateDefinition(directory: string): TemplateClass {
  const installNode = [
    "curl -fsSL https://deb.nodesource.com/setup_24.x | bash -",
    "apt-get install -y nodejs",
    'for b in node npm npx; do [ -x "/usr/bin/$b" ] && ln -sf "/usr/bin/$b" "/usr/local/bin/$b"; done',
    "true",
  ].join(" && ");
  return Template({
    fileContextPath: directory,
    fileIgnorePatterns: ["node_modules", "dist", ".git"],
  })
    .fromBaseImage()
    .runCmd(installNode, { user: "root" })
    .runCmd("curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash", { user: "root" })
    .runCmd(DESKTOP_INSTALL_COMMAND, { user: "root" })
    .makeDir("/usr/local/lib/nap-desktop", { user: "root" })
    .copy("desktop/driver.mjs", DESKTOP_DRIVER, { user: "root" })
    .copy("desktop/build", DESKTOP_BUILD_FILE, { user: "root" })
    .copy("desktop/start-desktop.sh", "/usr/local/bin/nap-desktop-start", { user: "root" })
    .runCmd("chmod 755 /usr/local/bin/nap-desktop-start", { user: "root" })
    .makeDir(TEMPLATE_WORKDIR, { user: "user" })
    .setWorkdir(TEMPLATE_WORKDIR)
    .setUser("user")
    .copy("app/package.json", TEMPLATE_WORKDIR, { user: "user" })
    .runCmd("bun install", { user: "user" })
    .copy("app", TEMPLATE_WORKDIR, { user: "user" })
    .runCmd(
      'git init -b main && git add -A && git -c user.email=agent@nap.dev -c user.name=Nap commit -m "Initial commit"',
      { user: "user" },
    )
    .setStartCmd(`cd ${TEMPLATE_WORKDIR} && bun run dev`, waitForPort(TEMPLATE_DEV_PORT));
}
