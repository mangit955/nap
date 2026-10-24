import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = new URL("../../../../apps/web/src/computer/recording-viewer.tsx", import.meta.url);
const workspace = fileURLToPath(new URL("../../../..", import.meta.url));
const original = await readFile(source, "utf8");
const mutations = [
  ["chapter-identity", "selection?.index ?? chapterIndexAt(time)", "chapterIndexAt(time)"],
  ["timeline-precision", "Math.round(seconds * 1000)", "seconds * 1000"],
  ["loop-lower-bound", "timeMs < loop.timeMs", "element.currentTime * 1000 < loop.timeMs"],
  [
    "automatic-on-play",
    "if (loopIndex === null) setSelection(null);",
    "// Mutated automatic selection.",
  ],
  [
    "automatic-while-playing",
    "if (!element.paused && loopIndex === null) setSelection(null);",
    "// Mutated selection during playback.",
  ],
  [
    "zero-duration-control",
    "disabled={!ready || !chapterHasDuration(currentIndex)}",
    "disabled={!ready}",
  ],
  [
    "zero-duration-navigation",
    "loop: loopIndex !== null && chapterHasDuration(index)",
    "loop: loopIndex !== null",
  ],
  ["slider-selection", "const index = chapterIndexAt(value);", "const index = 0;"],
  ["chapter-loop", "element.currentTime = loop.timeMs / 1000;", "setTime(element.currentTime);"],
  ["listener-cleanup", 'element.removeEventListener("timeupdate", onTime);', "// Mutated cleanup."],
  ["owner-cookies", 'crossOrigin="use-credentials"', 'crossOrigin="anonymous"'],
];

// Each mutation runs alone against the same source and is restored even on failure.
try {
  for (const [name, before, after] of mutations) {
    assert.equal(original.split(before).length, 2, `Unique mutation target: ${name}`);
    await writeFile(source, original.replace(before, after));
    const result = spawnSync(
      "bunx",
      [
        "--no-install",
        "vitest",
        "run",
        "--project",
        "web",
        "apps/web/src/computer/recording-viewer.test.tsx",
      ],
      { cwd: workspace, encoding: "utf8", timeout: 60000, maxBuffer: 4 * 1024 * 1024 },
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    await writeFile(new URL(`repair-mutation-${name}.txt`, import.meta.url), output);
    assert.equal(result.error, undefined, `Mutation runner error: ${name}`);
    assert.equal(result.status, 1, `Guard must fail: ${name}`);
    assert.match(output, /Tests\s+\d+ failed/, `Assertion failures required: ${name}`);
    console.log(`${name}: observed failing assertions`);
    await writeFile(source, original);
  }
} finally {
  await writeFile(source, original);
}
