/**
 * `.tsx` with no JSX in it, deliberately: filename decides the vitest project, and a `.test.ts`
 * here would be collected by `unit` and run in Node with no `location` to assert about.
 *
 * Only the decision is tested, not the navigation. Assigning to `location` in jsdom is a real
 * navigation attempt, and the pure predicate is where the rule that could be wrong actually
 * lives — "redirect on 401, except on the sign-in page itself".
 */

import { describe, expect, it } from "vitest";
import { SIGN_IN_PATH, shouldRedirectToSignIn } from "./credentialed-fetch.ts";

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
