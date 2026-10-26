import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_TEST_TASKS } from "@nap/bench/app-test";
import { afterEach, expect, it } from "vitest";
import { prepareAppTestFixture } from "./app-test-fixture.ts";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

it.each(APP_TEST_TASKS)(
  "executes $id's actual DOM handlers and separates its planted behavior",
  (task) => {
    const fixture = prepareAppTestFixture(task);
    try {
      const mount = () => {
        document.body.innerHTML = readFileSync(join(fixture.directory, "index.html"), "utf8");
        // The specimen is JavaScript, outside the TypeScript build; execute the same handlers the browser loads.
        new Function(
          "document",
          "localStorage",
          readFileSync(join(fixture.directory, "src/app.js"), "utf8"),
        )(document, localStorage);
      };
      mount();
      let observed: boolean;
      if (task.fixture === "notes") {
        const input = document.querySelector("input");
        expect(input).not.toBeNull();
        input!.value = "Buy milk";
        document.querySelector("button")!.click();
        expect(document.querySelector("ul")?.textContent).toContain("Buy milk");
        mount();
        observed = document.querySelector("ul")?.textContent?.includes("Buy milk") ?? false;
      } else {
        const input = document.querySelector("input");
        input!.value = "3";
        input!.dispatchEvent(new Event("input", { bubbles: true }));
        observed = document.querySelector("output")?.textContent === "$36.00";
      }
      expect(observed).toBe(task.expected === "passed");
    } finally {
      fixture.dispose();
    }
  },
);
