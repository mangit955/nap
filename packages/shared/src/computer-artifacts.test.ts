import { expect, it } from "vitest";
import { computerScreenshotKey } from "./computer-artifacts.ts";

it("names a screenshot by the durable call identity and escapes every path segment", () => {
  expect(
    computerScreenshotKey({
      projectId: "p/other",
      sessionId: "s",
      turnId: "t",
      toolCallId: "../screen",
    }),
  ).toBe("computer/p%2Fother/s/t/..%2Fscreen.jpg");
  expect(
    computerScreenshotKey({ projectId: "p", sessionId: "s", turnId: "t", toolCallId: "c" }),
  ).toBe("computer/p/s/t/c.jpg");
});
