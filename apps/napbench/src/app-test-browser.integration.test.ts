/**
 * Free actual-Chrome check of the planted app specimens. Needs only NAP_CHROME_PATH.
 * Browser requests are fulfilled from local fixture bytes. No E2B, model, credentials or
 * network service is used. Each case gets its own browser and storage; reload stays native.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_TEST_TASKS } from "@nap/bench/app-test";
import { chromium } from "playwright-core";
import { describe, expect, it } from "vitest";

const chrome = process.env.NAP_CHROME_PATH;

describe.skipIf(chrome === undefined)("app-test specimens in actual Chrome", () => {
  it.each(APP_TEST_TASKS)("distinguishes $id through its actual main flow", async (task) => {
    if (chrome === undefined) throw new Error("NAP_CHROME_PATH is required for this suite.");
    const directory = join(import.meta.dirname, "../fixtures/app-test", task.fixture);
    const html = readFileSync(join(directory, "index.html"), "utf8");
    const script = readFileSync(
      join(directory, task.variant === "correct" ? "app.js" : "app-buggy.js"),
      "utf8",
    );
    const browser = await chromium.launch({ executablePath: chrome, headless: true });
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/*", async (route) => {
        const path = new URL(route.request().url()).pathname;
        await route.fulfill(
          path === "/"
            ? { contentType: "text/html", body: html }
            : path === "/src/app.js"
              ? { contentType: "text/javascript", body: script }
              : { status: 404, body: "" },
        );
      });
      await page.goto("http://127.0.0.1:43181/");
      let observed: boolean;
      if (task.fixture === "notes") {
        await page.getByRole("textbox", { name: "Note" }).fill("Buy milk");
        await page.getByRole("button", { name: "Save note" }).click();
        expect(await page.getByRole("list").textContent()).toContain("Buy milk");
        await page.reload();
        observed = (await page.getByRole("list").textContent())?.includes("Buy milk") ?? false;
      } else {
        await page.getByRole("spinbutton", { name: "Quantity" }).fill("3");
        observed = (await page.getByRole("status").textContent()) === "$36.00";
      }
      expect(observed).toBe(task.expected === "passed");
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });
});
