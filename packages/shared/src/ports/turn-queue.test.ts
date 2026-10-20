import { expect, it } from "vitest";
import { SessionActivitySchema } from "./turn-queue.ts";

const observation = {
  sessionId: "00000000-0000-4000-8000-000000000001",
  throughSeq: 12,
  active: false,
};
it("accepts the complete covered activity response", () => {
  expect(SessionActivitySchema.parse(observation)).toEqual(observation);
});
it.each([
  { ...observation, sessionId: "bad" },
  { ...observation, throughSeq: -1 },
  { ...observation, throughSeq: 1.5 },
  { ...observation, throughSeq: Number.MAX_SAFE_INTEGER + 1 },
  { ...observation, active: "false" },
  { ...observation, unsupported: true },
  { sessionId: observation.sessionId, throughSeq: 0 },
])("rejects malformed activity response %#", (value) => {
  expect(SessionActivitySchema.safeParse(value).success).toBe(false);
});
