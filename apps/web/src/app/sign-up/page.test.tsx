import { describe, expect, it, vi } from "vitest";

// The real form constructs the auth client on import; what is under test is only what the page
// hands it.
vi.mock("../../auth/live-sign-in.tsx", () => ({ LiveSignIn: () => null }));

const { default: Page } = await import("./page.tsx");

describe("/sign-up", () => {
  it("keeps a guest who came to upgrade on the page", async () => {
    // The sign-in half corrects the address bar to `/sign-up?upgrade=1`; without this a reload
    // would send the guest back to the dashboard.
    const page = await Page({ searchParams: Promise.resolve({ upgrade: "1" }) });
    expect(page.props).toMatchObject({ initialMode: "sign-up", upgrade: true });
  });

  it("is an ordinary sign-up otherwise", async () => {
    const page = await Page({ searchParams: Promise.resolve({}) });
    expect(page.props).toMatchObject({ initialMode: "sign-up", upgrade: false });
  });
});
