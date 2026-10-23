import { describe, expect, it } from "vitest";
import {
  CreateProviderAccountSchema,
  ProviderAccountSchema,
  ProviderSignInSchema,
  UpdateProviderAccountSchema,
} from "./provider-accounts-protocol.ts";

const ACCOUNT = {
  id: "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f",
  driver: "claude",
  label: null,
  enabled: true,
  auth: { status: "unauthenticated", email: null, plan: null },
  createdAt: "2026-10-23T09:00:00.000Z",
};

describe("ProviderAccountSchema", () => {
  it("accepts an account nobody has signed in to yet", () => {
    expect(ProviderAccountSchema.parse(ACCOUNT)).toEqual(ACCOUNT);
  });

  it("refuses a driver Nap cannot run", () => {
    expect(ProviderAccountSchema.safeParse({ ...ACCOUNT, driver: "cursor" }).success).toBe(false);
  });
});

describe("CreateProviderAccountSchema", () => {
  it("trims the label, so a name of spaces is no name at all", () => {
    expect(CreateProviderAccountSchema.parse({ driver: "codex", label: "  Work  " })).toEqual({
      driver: "codex",
      label: "Work",
    });
    expect(CreateProviderAccountSchema.safeParse({ driver: "codex", label: "   " }).success).toBe(
      false,
    );
  });

  it("caps the label at the width the provider list can show", () => {
    expect(
      CreateProviderAccountSchema.safeParse({ driver: "codex", label: "x".repeat(41) }).success,
    ).toBe(false);
  });
});

describe("UpdateProviderAccountSchema", () => {
  it("accepts a label cleared back to the provider's own name", () => {
    expect(UpdateProviderAccountSchema.parse({ label: null })).toEqual({ label: null });
  });

  it("refuses an update that changes nothing", () => {
    expect(UpdateProviderAccountSchema.safeParse({}).success).toBe(false);
  });
});

describe("ProviderSignInSchema", () => {
  it("carries a terminal's output while Claude Code's own login runs", () => {
    const flow = {
      flowId: "flow-1",
      phase: "waiting",
      interaction: { type: "terminal", output: "$ claude auth login\n" },
      message: null,
    };

    expect(ProviderSignInSchema.parse(flow)).toEqual(flow);
  });

  it("refuses a browser step whose link is not a URL", () => {
    expect(
      ProviderSignInSchema.safeParse({
        flowId: "flow-1",
        phase: "waiting",
        interaction: { type: "browser", url: "not a url" },
        message: null,
      }).success,
    ).toBe(false);
  });

  it("refuses a browser step that is not https, since it is rendered as a link", () => {
    expect(
      ProviderSignInSchema.safeParse({
        flowId: "flow-1",
        phase: "waiting",
        interaction: { type: "browser", url: "javascript:alert(1)" },
        message: null,
      }).success,
    ).toBe(false);
  });
});
