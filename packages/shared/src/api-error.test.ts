import { describe, expect, it } from "vitest";
import { ApiErrorSchema, SIGN_IN_REQUIRED, SignInRequiredSchema } from "./api-error.ts";

describe("ApiErrorSchema", () => {
  it("reads the sentence and the code a refusal carries", () => {
    expect(ApiErrorSchema.parse({ error: "Nope.", code: "sandbox_quota_exceeded" })).toEqual({
      error: "Nope.",
      code: "sandbox_quota_exceeded",
    });
  });

  it("accepts a refusal that gave no code", () => {
    expect(ApiErrorSchema.parse({ error: "Untrusted request origin." })).toEqual({
      error: "Untrusted request origin.",
    });
  });

  it("refuses a body with no sentence to show", () => {
    expect(ApiErrorSchema.safeParse({ code: SIGN_IN_REQUIRED }).success).toBe(false);
    expect(ApiErrorSchema.safeParse(null).success).toBe(false);
  });
});

describe("SignInRequiredSchema", () => {
  it("accepts the guest refusal", () => {
    const body = { error: "Sign in to connect GitHub.", code: "sign_in_required" };
    expect(SignInRequiredSchema.parse(body)).toEqual(body);
  });

  it("is still an error body, so a caller reading any refusal can read this one", () => {
    const body = SignInRequiredSchema.parse({ error: "Sign in.", code: SIGN_IN_REQUIRED });
    expect(ApiErrorSchema.parse(body).code).toBe(SIGN_IN_REQUIRED);
  });

  it("refuses any other code, so the API cannot mark a guest refusal with a typo", () => {
    expect(
      SignInRequiredSchema.safeParse({ error: "Sign in.", code: "signin_required" }).success,
    ).toBe(false);
    expect(SignInRequiredSchema.safeParse({ error: "Sign in." }).success).toBe(false);
  });
});
