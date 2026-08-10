/**
 * `.tsx` with no JSX in it, deliberately: filename decides the vitest project, and a `.test.ts`
 * here would be collected by `unit` and run in Node with no `location` to assert about.
 *
 * The pure predicate carries the rule — "redirect on 401, except on the sign-in page itself" —
 * and the second half covers where it actually sends you, with `location` stubbed wholesale
 * because jsdom refuses a real navigation. That second half exists because deleting the query
 * parameter from the redirect left every other test here green.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  credentialedFetch,
  EXPIRED_SIGN_IN_PATH,
  SIGN_IN_PATH,
  shouldRedirectToSignIn,
} from "./credentialed-fetch.ts";

describe("shouldRedirectToSignIn", () => {
  it("redirects when the API says the caller is not signed in", () => {
    expect(shouldRedirectToSignIn(401, "/")).toBe(true);
    expect(shouldRedirectToSignIn(401, "/p/abc")).toBe(true);
  });

  it("stays put on the sign-in page, where a 401 is a wrong password", () => {
    // Redirecting to the page you are already on clears the form, so a failed sign-in would
    // look like the app silently discarding what you typed.
    expect(shouldRedirectToSignIn(401, SIGN_IN_PATH)).toBe(false);
  });

  it("leaves every other status alone", () => {
    // 403 and 404 are answers about a *thing*, not about who you are. Sending someone to sign
    // in when they are already signed in is a loop.
    for (const status of [200, 201, 403, 404, 409, 500, 503]) {
      expect(shouldRedirectToSignIn(status, "/")).toBe(false);
    }
  });
});

describe("where a 401 actually sends the browser", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Replaces `location` wholesale: jsdom refuses a real navigation, and this is what the code reads. */
  function stubLocation(pathname: string) {
    const assign = vi.fn();
    vi.stubGlobal("location", { pathname, assign });
    return assign;
  }

  it("carries the reason, so the sign-in page can explain itself", async () => {
    // The mutation this exists for: sending them to a bare `/sign-in` passes every other test
    // here and leaves the user staring at a login form with no idea why their work vanished.
    const assign = stubLocation("/p/abc");
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 401 }));

    await credentialedFetch("http://api.test/projects");

    expect(assign).toHaveBeenCalledWith(EXPIRED_SIGN_IN_PATH);
    expect(EXPIRED_SIGN_IN_PATH).toContain("expired");
  });

  it("does not navigate on a successful response", async () => {
    const assign = stubLocation("/p/abc");
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));

    await credentialedFetch("http://api.test/projects");

    expect(assign).not.toHaveBeenCalled();
  });

  it("stays put when the 401 came from the sign-in form itself", async () => {
    const assign = stubLocation(SIGN_IN_PATH);
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 401 }));

    await credentialedFetch("http://api.test/api/auth/sign-in/email");

    expect(assign).not.toHaveBeenCalled();
  });
});
