/**
 * The one place the duplicated dev port can be checked, and therefore the place it is.
 *
 * `docs/adr/0001` makes `@nap/bench` pure — `@nap/shared` and zod, nothing else — so a task
 * cannot import `TEMPLATE_DEV_PORT` from the sandbox template it is nonetheless served from, and
 * `TEMPLATE_PREVIEW_PORT` restates the number. This app depends on both packages, so it is the
 * only layer that can see the two at once.
 *
 * Without this, moving the dev server would leave every browser check in the benchmark timing out
 * against a port nothing listens on — a failure that looks exactly like four models simultaneously
 * forgetting how to start a dev server.
 */

import { TEMPLATE_PREVIEW_PORT } from "@nap/bench/tasks/template";
import { TEMPLATE_DEV_PORT } from "@nap/sandbox/template";
import { describe, expect, it } from "vitest";

describe("the benchmark's idea of the preview port", () => {
  it("agrees with the template's", () => {
    expect(TEMPLATE_PREVIEW_PORT).toBe(TEMPLATE_DEV_PORT);
  });
});
