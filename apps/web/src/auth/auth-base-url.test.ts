import { describe, expect, it } from "vitest";
import { authBaseUrl } from "./auth-base-url.ts";

describe("authBaseUrl", () => {
  it("names the auth routes on an API reached directly", () => {
    expect(authBaseUrl("http://localhost:3001")).toBe("http://localhost:3001/api/auth");
  });

  it("keeps the path the web app publishes the API under", () => {
    // The client takes a base URL with a path as the whole of it, so without this it would post
    // to `/backend/sign-in/email` and miss the auth routes entirely.
    expect(authBaseUrl("https://nap-tawny.vercel.app/backend")).toBe(
      "https://nap-tawny.vercel.app/backend/api/auth",
    );
    expect(authBaseUrl("https://nap-tawny.vercel.app/backend/")).toBe(
      "https://nap-tawny.vercel.app/backend/api/auth",
    );
  });
});
