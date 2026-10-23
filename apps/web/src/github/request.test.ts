import { SIGN_IN_REQUIRED } from "@nap/shared/api-error";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { githubRequest } from "./request.ts";

const Body = z.object({ ok: z.literal(true) });
const answer = (body: unknown, status: number) => async () => Response.json(body, { status });

describe("githubRequest", () => {
  it("passes on the refusal's sentence and its code", async () => {
    const result = await githubRequest(
      answer({ error: "Sign in.", code: SIGN_IN_REQUIRED }, 403),
      "/x",
      Body,
    );
    expect(result).toEqual({ ok: false, error: "Sign in.", code: SIGN_IN_REQUIRED });
  });

  it("falls back to its own sentence when the refusal is not an error body", async () => {
    const result = await githubRequest(answer({ code: SIGN_IN_REQUIRED }, 403), "/x", Body);
    expect(result).toEqual({
      ok: false,
      error: "GitHub could not complete that request. Try again.",
    });
  });

  it("parses a success with the caller's schema", async () => {
    expect(await githubRequest(answer({ ok: true }, 200), "/x", Body)).toEqual({
      ok: true,
      value: { ok: true },
    });
  });
});
