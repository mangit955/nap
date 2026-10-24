import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const { chromium } = await import(
  new URL("../../../../apps/napbench/node_modules/playwright-core/index.mjs", import.meta.url)
);
const directory = fileURLToPath(new URL(".", import.meta.url));
const browser = await chromium.launch({
  executablePath:
    process.env.NAP_CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const base = process.argv[2] ?? "http://localhost:3037/computer-live-review";
assert.equal(new URL(base).hostname, "localhost");
const screenshot = await readFile(new URL("../panel-review/fixture-desktop.jpg", import.meta.url));
await page.route("**/computer/screenshots/*", (route) =>
  route.fulfill({ contentType: "image/jpeg", body: screenshot }),
);
try {
  await page.goto(base);
  await page.getByRole("button", { name: "Take control of Nap's computer" }).waitFor();
  await page.waitForFunction(() => !!document.querySelector("canvas[width='1024'][height='768']"));
  await page
    .getByRole("button", { name: "Take control of Nap's computer" })
    .waitFor({ state: "visible" });
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll("button")].find(
        (button) => button.textContent === "Take control of Nap's computer",
      )?.disabled,
  );
  assert.equal(await page.getByRole("application", { name: "Remote computer" }).count(), 1);
  await page.screenshot({ path: `${directory}/nap-computer-live.png` });
  const interior = async () => {
    const box = await page.getByRole("application", { name: "Remote computer" }).boundingBox();
    assert(box);
    return page.screenshot({
      clip: {
        x: Math.floor(box.x + box.width * 0.3),
        y: Math.floor(box.y + box.height * 0.42),
        width: 8,
        height: 8,
      },
    });
  };
  const pixelsBeforeControl = await interior();
  await page.getByRole("combobox", { name: "Stream quality" }).selectOption("sharp");
  await page.getByRole("button", { name: "Take control of Nap's computer" }).click();
  await page.getByRole("button", { name: "Release control" }).waitFor();
  await page.waitForFunction(() => {
    const rim = document.querySelector(".computer-frame .ai-lights-layer");
    return (
      rim &&
      Number(getComputedStyle(rim).opacity) > 0.2 &&
      rim
        .getAnimations()
        .some(
          (animation) =>
            Number(animation.currentTime) > 400 && Number(animation.currentTime) < 1000,
        )
    );
  });
  assert.deepEqual(
    await interior(),
    pixelsBeforeControl,
    "The driving glow must not paint over the framebuffer interior",
  );
  const desktopBounds = await page.locator("canvas[width='1024']").boundingBox();
  const inputBounds = await page
    .getByRole("textbox", { name: "Type on the remote computer" })
    .boundingBox();
  assert(desktopBounds && inputBounds);
  const scale = Math.min(inputBounds.width / 1024, inputBounds.height / 768);
  const inputFrame = {
    x: inputBounds.x + (inputBounds.width - 1024 * scale) / 2,
    y: inputBounds.y + (inputBounds.height - 768 * scale) / 2,
    width: 1024 * scale,
    height: 768 * scale,
  };
  for (const field of ["x", "y", "width", "height"])
    assert(Math.abs(desktopBounds[field] - inputFrame[field]) < 1);
  await page.getByRole("textbox", { name: "Type on the remote computer" }).press("Escape");
  assert.equal(await page.getByRole("button", { name: "Release control" }).isVisible(), true);
  await page.screenshot({ path: `${directory}/nap-computer-driving.png` });
  await page.getByRole("textbox", { name: "Type on the remote computer" }).press("Shift+Escape");
  await page.getByRole("button", { name: "Take control of Nap's computer" }).waitFor();
  await page.getByRole("button", { name: "Previous event", exact: true }).click();
  await page.getByRole("img", { name: "Computer screenshot" }).waitFor();
  assert.equal(await page.locator("canvas[width='1024']").count(), 0);
  await page.screenshot({ path: `${directory}/nap-computer-history.png` });
  await page.getByRole("button", { name: "Go to live desktop" }).click();
  await page.waitForFunction(() => !!document.querySelector("canvas[width='1024']"));
  await page.getByRole("button", { name: "Start turn fixture" }).click();
  assert.equal(
    await page.getByRole("button", { name: "Take control of Nap's computer" }).isDisabled(),
    true,
  );
  await page.screenshot({ path: `${directory}/nap-computer-busy.png` });
  await page.getByRole("button", { name: "End turn fixture" }).click();
  await page.getByRole("button", { name: "Disconnect fixture" }).click();
  await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
  await page.screenshot({ path: `${directory}/nap-computer-disconnected.png` });
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.waitForFunction(() => !!document.querySelector("canvas[width='1024']"));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const bounds = await page.getByRole("application", { name: "Remote computer" }).boundingBox();
  assert(bounds && Math.abs(bounds.width / bounds.height - 4 / 3) < 0.02);
  await page.screenshot({ path: `${directory}/nap-computer-phone.png` });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.getByRole("button", { name: "Show recording fixture" }).click();
  await page.getByRole("button", { name: "Watch recording" }).click();
  const video = page.getByLabel("Test recording", { exact: true });
  await page.waitForFunction(() => {
    const video = document.querySelector("video");
    return video && video.readyState >= 2 && video.videoWidth === 1024 && video.videoHeight === 768;
  });
  await page.getByRole("button", { name: "Play recording" }).click();
  await page.waitForFunction(() => document.querySelector("video")?.currentTime > 0);
  const videoTime = await video.evaluate((element) => element.currentTime);
  assert(videoTime > 0);
  await page.getByRole("button", { name: "Pause recording" }).click();
  await page
    .getByRole("navigation", { name: "Recording chapters" })
    .getByRole("button", { name: /Setup/ })
    .click();
  await page.getByRole("button", { name: "Next chapter", exact: true }).click();
  await page.screenshot({ path: `${directory}/nap-test-recording.png` });
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download recording" }).click();
  const download = await downloadEvent;
  const downloaded = await readFile(await download.path());
  assert.deepEqual(
    downloaded,
    await readFile(
      new URL("../../../research/computer-recording-linux/capture.mp4", import.meta.url),
    ),
  );
  await page.getByRole("button", { name: "Close test recording viewer" }).click();
  assert.equal(await page.getByRole("dialog", { name: "Test recording viewer" }).count(), 0);
  const transport = await fetch("http://127.0.0.1:43179/state").then((response) => response.json());
  assert.equal(transport.forbidden, 0);
  assert.deepEqual(errors, []);
  await writeFile(
    `${directory}/browser-evidence.json`,
    JSON.stringify(
      {
        videoTime,
        downloadedBytes: downloaded.byteLength,
        desktopBounds,
        inputBounds,
        errors,
        bounds,
        transport,
        liveTransport: "local raw RFB fixture",
        ownerInput: "fake HTTP",
        cloud: false,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: ComputerPane/noVNC, history teardown, retry, quality, idle control, remote keys, framebuffer pixels, 390px layout, real MP4 playback/chapters/download and viewer cleanup. Fake identity/input/storage and local RFB only.",
  );
  execFileSync(
    "bunx",
    ["--no-install", "biome", "format", "--write", `${directory}/browser-evidence.json`],
    { stdio: "pipe" },
  );
} finally {
  await browser.close();
}
