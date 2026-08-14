import { describe, expect, it } from "vitest";
import { isCrossSite } from "./cross-site.ts";

describe("isCrossSite", () => {
  it("is true when the browser app and this API are on different hosts over https", () => {
    expect(isCrossSite("https://nap-api.up.railway.app", "https://nap.vercel.app")).toBe(true);
  });

  it("is false in development, where both are localhost on different ports", () => {
    // A `Secure` cookie over plain http is refused by most of the ways this gets debugged,
    // and two ports on one host are the same site regardless.
    expect(isCrossSite("http://localhost:3001", "http://localhost:3000")).toBe(false);
  });

  it("is false when the two are the same host, so a same-origin deployment keeps Lax", () => {
    expect(isCrossSite("https://nap.example.com", "https://nap.example.com")).toBe(false);
  });

  it("is false when the API is not served over https, whatever the hosts are", () => {
    // `SameSite=None` requires `Secure`, and a `Secure` cookie cannot be set over http — so
    // saying "cross-site" here would swap a cookie that works for one that is never stored.
    expect(isCrossSite("http://api.example.com", "https://app.example.com")).toBe(false);
  });

  it("ignores the port, which is not part of what makes two URLs the same site", () => {
    expect(isCrossSite("https://example.com:8443", "https://example.com")).toBe(false);
  });
});
