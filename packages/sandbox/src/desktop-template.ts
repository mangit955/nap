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
import { z } from "zod";
import { NAP_TEMPLATE } from "./template.ts";

export const DESKTOP_INSTALL_COMMAND =
  "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y python3 libx11-6 libxtst6 xvfb x11-utils openbox xdotool ffmpeg x11vnc websockify novnc dbus-x11 fonts-liberation ca-certificates wget openssl util-linux && wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -O /tmp/nap-chrome.deb && apt-get install -y /tmp/nap-chrome.deb && rm /tmp/nap-chrome.deb && mkdir -p /etc/opt/chrome/policies/managed && chown user:user /etc/opt/chrome/policies/managed";
const ManifestSchema = z.strictObject({
  version: z.literal(1),
  template: z.literal(NAP_TEMPLATE),
  cpuCount: z.literal(2),
  memoryMB: z.literal(1024),
  files: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
});
export type DesktopTemplateManifest = z.infer<typeof ManifestSchema>;
type Prepared = Result<DesktopTemplateManifest, { message: string }>;
const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
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
    const manifest: DesktopTemplateManifest = {
      version: 1,
      template: NAP_TEMPLATE,
      cpuCount: 2,
      memoryMB: 1024,
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
    return { ok: true, value: manifest };
  } catch {
    return {
      ok: false,
      error: { message: "Prepared template manifest is unavailable or invalid." },
    };
  }
}
