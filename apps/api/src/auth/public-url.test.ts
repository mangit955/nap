import { describe, expect, it } from "vitest";
import { asPublicRequest, authBaseUrl } from "./public-url.ts";

describe("authBaseUrl", () => {
  it("puts the auth routes under the API's public address", () => {
    expect(authBaseUrl("http://localhost:3001")).toBe("http://localhost:3001/api/auth");
  });

  it("keeps a path the API is published under, which is how the web app proxies it", () => {
    // OAuth redirect URIs are built from this, so the provider has to send the browser back
    // through the proxy — where the cookie is first-party — and not to the API's own host.
    expect(authBaseUrl("https://nap-tawny.vercel.app/backend")).toBe(
      "https://nap-tawny.vercel.app/backend/api/auth",
    );
    expect(authBaseUrl("https://nap-tawny.vercel.app/backend/")).toBe(
      "https://nap-tawny.vercel.app/backend/api/auth",
    );
  });
});

describe("asPublicRequest", () => {
  it("restores the address the browser used, which the proxy stripped", async () => {
    // The library routes on the path of its base URL, so a request that arrives as
    // `/api/auth/…` on the API's own host must read as `/backend/api/auth/…` on the public one.
    const arrived = new Request("https://nap-api.onrender.com/api/auth/sign-in/email?x=1", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://nap-tawny.vercel.app" },
      body: JSON.stringify({ email: "a@b.c" }),
    });

    const request = asPublicRequest(arrived, "https://nap-tawny.vercel.app/backend");

    expect(request.url).toBe("https://nap-tawny.vercel.app/backend/api/auth/sign-in/email?x=1");
    expect(request.method).toBe("POST");
    expect(request.headers.get("origin")).toBe("https://nap-tawny.vercel.app");
    await expect(request.json()).resolves.toEqual({ email: "a@b.c" });
  });

  it("hands back the same request when nothing is in front of the API", () => {
    const arrived = new Request("http://localhost:3001/api/auth/get-session");

    expect(asPublicRequest(arrived, "http://localhost:3001")).toBe(arrived);
  });
});
