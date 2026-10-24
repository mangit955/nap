/** Free, opt-in UI acceptance for computer-local.ts. Requires its run.json and a local Chrome.
 * Never starts E2B or calls a model. Only the fixed loopback launcher profile is accepted.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DesktopObservationSchema, DesktopReplySchema } from "@nap/sandbox/desktop-protocol";
import { chromium } from "playwright-core";
import { expect, it } from "vitest";
import { z } from "zod";

const manifestPath = process.env.NAP_COMPUTER_LOCAL_MANIFEST;
const chromePath = process.env.NAP_CHROME_PATH;
const run = promisify(execFile);
const Manifest = z.object({
  mode: z.literal("scripted-local-docker"),
  workspace: z.url(),
  api: z.literal("http://127.0.0.1:3048"),
  projectId: z.uuid(),
  sessionId: z.uuid(),
});

it.skipIf(!manifestPath || !chromePath)(
  "runs the real Nap desktop, test, fix and recording path locally",
  async () => {
    if (!manifestPath || !chromePath)
      throw new Error("Local launcher manifest and Chrome are required.");
    const manifest = Manifest.parse(JSON.parse(await readFile(manifestPath, "utf8")));
    expect(manifest.workspace).toBe(`http://127.0.0.1:3047/p/${manifest.projectId}`);
    const output =
      process.env.NAP_COMPUTER_LOCAL_EVIDENCE ?? (await mkdtemp(join(tmpdir(), "nap-local-ui-")));
    await mkdir(output, { recursive: true });
    const browser = await chromium.launch({ executablePath: chromePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const proof: Record<string, unknown> = { paid: false, mode: manifest.mode };
    try {
      await page.goto("http://127.0.0.1:3047/sign-in");
      await page.getByLabel("Email", { exact: true }).fill("reader@computer.test");
      await page.getByLabel("Password", { exact: true }).fill("Computer-local-42");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 30000 });
      await page.goto(manifest.workspace);
      // Run against a freshly seeded launcher: rewriting identical source creates no new checkpoint.
      expect(await page.getByRole("region", { name: "App test results" }).count()).toBe(0);
      await expect
        .poll(() => page.getByRole("button", { name: "Test the app", exact: true }).isEnabled(), {
          timeout: 15000,
        })
        .toBe(true);
      const projectResponse = await context.request.get(
        `${manifest.api}/projects/${manifest.projectId}`,
      );
      expect(projectResponse.status()).toBe(200);
      const project = z
        .object({ name: z.string(), sandboxId: z.string().regex(/^[a-f0-9]{64}$/) })
        .parse(await projectResponse.json());
      expect(project.name).toContain("scripted model");
      const dom = async () => {
        const request = Buffer.from(
          JSON.stringify({ id: randomUUID(), op: "act", action: { action: "read_dom" } }),
        ).toString("base64");
        const result = await run(
          "docker",
          ["exec", project.sandboxId, "node", "/usr/local/lib/nap-desktop/driver.mjs", request],
          { timeout: 15000, maxBuffer: 3_200_000 },
        );
        const reply = DesktopReplySchema.parse(JSON.parse(result.stdout));
        if (!reply.ok) throw new Error("Read-only production DOM diagnostic failed.");
        const observation = DesktopObservationSchema.parse(reply.value);
        if (observation.kind !== "text") throw new Error("Expected a real DOM observation.");
        return observation.text;
      };
      const computer = page.getByRole("tab", { name: "Computer", exact: true });
      if ((await computer.count()) === 0) {
        await page.getByLabel("Add panel", { exact: true }).click();
        await page.getByRole("menuitem", { name: "Computer", exact: true }).click();
      }
      await computer.click();
      const screen = page.getByRole("application", { name: "Remote computer", exact: true });
      const canvas = screen.locator("canvas");
      // The desktop start command has a 55-second bound before credentials and connection.
      await canvas.waitFor({ state: "visible", timeout: 70000 });
      await expect
        .poll(
          () =>
            page
              .getByRole("button", { name: "Take control of Nap's computer", exact: true })
              .isEnabled(),
          { timeout: 30000 },
        )
        .toBe(true);
      const frame = async (name: string) => {
        const data = await canvas.evaluate((element) => {
          if (!(element instanceof HTMLCanvasElement)) throw new Error("Expected noVNC canvas.");
          if (element.width !== 1024 || element.height !== 768)
            throw new Error("Unexpected desktop dimensions.");
          return element.toDataURL("image/png").split(",")[1];
        });
        if (!data) throw new Error("Missing framebuffer data.");
        await writeFile(join(output, name), Buffer.from(data, "base64"));
      };
      await frame("live-before.png");
      proof.authenticatedLiveDesktop = true;
      const anonymous = await fetch(
        `${manifest.api}/sessions/${manifest.sessionId}/computer/stream`,
      );
      expect(anonymous.status).toBe(401);
      proof.anonymousDenied = true;

      const headers = { origin: "http://127.0.0.1:3047", "content-type": "application/json" };
      const grantResponse = await context.request.post(
        `${manifest.api}/sessions/${manifest.sessionId}/computer/control`,
        { headers, data: {} },
      );
      expect(grantResponse.status()).toBe(200);
      const grant = z.object({ grant: z.string() }).parse(await grantResponse.json()).grant;
      const results = page.getByRole("region", { name: "App test results" });
      const previousTests = await results.count();
      await page.getByRole("button", { name: "Test the app", exact: true }).click();
      await expect
        .poll(
          async () =>
            (
              await context.request.get(
                `${manifest.api}/sessions/${manifest.sessionId}/computer/control`,
              )
            ).status(),
          { timeout: 15000 },
        )
        .toBe(409);
      const denied = await context.request.post(
        `${manifest.api}/sessions/${manifest.sessionId}/computer/input`,
        { headers, data: { grant, actions: [{ action: "type", text: "MUST-NOT-BE-APPLIED" }] } },
      );
      expect(denied.status()).toBe(409);
      proof.leasedInputDenied = true;
      const failed = results.nth(previousTests);
      await expect.poll(() => failed.innerText(), { timeout: 90000 }).toContain("Failed 1");
      await expect
        .poll(
          () => failed.getByRole("button", { name: "Watch recording", exact: true }).isEnabled(),
          { timeout: 60000 },
        )
        .toBe(true);
      await failed.getByRole("button", { name: "Watch recording", exact: true }).click();
      const video = page.locator("video");
      await expect
        .poll(
          () =>
            video.evaluate(
              (element) =>
                element instanceof HTMLVideoElement &&
                element.readyState >= 1 &&
                element.videoWidth === 1024,
            ),
          { timeout: 15000 },
        )
        .toBe(true);
      const media = await video.getAttribute("src");
      if (!media?.startsWith(`${manifest.api}/`)) throw new Error("Missing owner media URL.");
      const complete = await context.request.get(media);
      expect(complete.status()).toBe(200);
      const bytes = await complete.body();
      expect(bytes.byteLength).toBeGreaterThan(1000);
      expect(bytes.toString("ascii", 4, 8)).toBe("ftyp");
      const range = await context.request.get(media, { headers: { range: "bytes=0-31" } });
      expect(range.status()).toBe(206);
      expect(await range.body()).toEqual(bytes.subarray(0, 32));
      const downloaded = await context.request.get(`${media}?download=1`);
      expect(await downloaded.body()).toEqual(bytes);
      expect(downloaded.headers()["content-disposition"]).toContain("attachment");
      await writeFile(join(output, "failed-test.mp4"), bytes);
      proof.recording = {
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        range: true,
        identicalDownload: true,
      };
      await video.evaluate((element) => {
        if (element instanceof HTMLVideoElement)
          element.currentTime = Math.min(1, element.duration / 2);
      });
      await expect
        .poll(() =>
          video.evaluate((element) =>
            element instanceof HTMLVideoElement ? element.currentTime : 0,
          ),
        )
        .toBeGreaterThan(0);
      await page.getByRole("button", { name: "Close test recording viewer", exact: true }).click();

      const stale = await context.request.post(
        `${manifest.api}/sessions/${manifest.sessionId}/computer/input`,
        { headers, data: { grant, actions: [{ action: "type", text: "STALE-MUST-NOT-APPLY" }] } },
      );
      expect(stale.status()).toBe(409);
      proof.staleGrantDenied = true;
      await failed.getByRole("button", { name: "Fix it", exact: true }).click();
      await expect
        .poll(() => page.getByRole("button", { name: "Test the app", exact: true }).isEnabled(), {
          timeout: 60000,
        })
        .toBe(true);
      await computer.click();
      await page
        .getByRole("button", { name: "Take control of Nap's computer", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Release control", exact: true })
        .waitFor({ state: "visible" });
      const bounds = await canvas.boundingBox();
      if (!bounds) throw new Error("Framebuffer has no bounds.");
      await page.mouse.click(
        bounds.x + (bounds.width * 448) / 1024,
        bounds.y + (bounds.height * 400) / 768,
      );
      await page
        .getByRole("textbox", { name: "Type on the remote computer", exact: true })
        .fill("OwnerInputProof");
      await page.mouse.click(
        bounds.x + (bounds.width * 744) / 1024,
        bounds.y + (bounds.height * 400) / 768,
      );
      await expect.poll(dom, { timeout: 15000 }).toContain(">OwnerInputProof</li>");
      await frame("owner-input.png");
      proof.realOwnerMouseAndTyping = true;
      await page.keyboard.press("Shift+Escape");
      const beforeRetest = await results.count();
      await page.getByRole("button", { name: "Test the app", exact: true }).click();
      const passed = results.nth(beforeRetest);
      await expect.poll(() => passed.innerText(), { timeout: 90000 }).toContain("Passed 1");
      await expect
        .poll(
          () => passed.getByRole("button", { name: "Watch recording", exact: true }).isEnabled(),
          { timeout: 60000 },
        )
        .toBe(true);
      proof.actualSourceFixAndRetest = true;
      await page.screenshot({ path: join(output, "nap-passed.png") });
      proof.ok = true;
    } catch (error) {
      proof.ok = false;
      proof.failure = String(error);
      await page.screenshot({ path: join(output, "failure.png") }).catch(() => undefined);
      throw error;
    } finally {
      await writeFile(join(output, "report.json"), `${JSON.stringify(proof, null, 2)}\n`);
      await context.close();
      await browser.close();
    }
  },
  300000,
);
