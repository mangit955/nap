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

  it("is false when both halves are subdomains of one registrable domain", () => {
    // The deployment to aim for: the app on one subdomain, the API on another. Same site, so
    // the cookie goes back to first-party `Lax` and Safari stops blocking it.
    expect(isCrossSite("https://api.example.com", "https://nap.example.com")).toBe(false);
  });

  it("is false when one host is a subdomain of the other", () => {
    expect(isCrossSite("https://api.example.com", "https://example.com")).toBe(false);
    expect(isCrossSite("https://example.com", "https://api.example.com")).toBe(false);
  });

  it("is false for deeper subdomains that still share a registrable domain", () => {
    expect(isCrossSite("https://api.eu.example.com", "https://nap.us.example.com")).toBe(false);
  });

  it("is true when the registrable domains differ, however similar the hosts look", () => {
    expect(isCrossSite("https://api.example.com", "https://api.example.org")).toBe(true);
    expect(isCrossSite("https://api.example.com", "https://api.notexample.com")).toBe(true);
  });

  it("stays true for two tenants of one hosting suffix, which are not the same site", () => {
    // `vercel.app` and `railway.app` are public suffixes: every customer gets a subdomain of
    // one, and two of them are no more the same site than two unrelated domains. Reporting
    // them same-site would drop the cookie back to `Lax`, which breaks sign-in in *every*
    // browser rather than in Safari alone — so the shared-parent rule below skips them.
    expect(isCrossSite("https://nap-api.vercel.app", "https://nap.vercel.app")).toBe(true);
    expect(isCrossSite("https://a.up.railway.app", "https://b.up.railway.app")).toBe(true);
  });

  it("keeps a real subdomain of one tenant same-site, hosting suffix or not", () => {
    expect(isCrossSite("https://api.nap.vercel.app", "https://nap.vercel.app")).toBe(false);
  });

  it("does not let a bare hosting suffix pose as a tenant's parent", () => {
    // The subdomain rule would otherwise walk around the guard above: `nap.vercel.app` ends
    // with `.vercel.app`, and calling those one site is the same expensive mistake.
    expect(isCrossSite("https://vercel.app", "https://nap.vercel.app")).toBe(true);
    expect(isCrossSite("https://nap.vercel.app", "https://vercel.app")).toBe(true);
  });

  it("is true for two hosts reached by address, which share labels without sharing a name", () => {
    expect(isCrossSite("https://192.168.0.1", "https://10.0.0.1")).toBe(true);
    expect(isCrossSite("https://[2001:db8::1]", "https://[2001:db8::2]")).toBe(true);
  });

  it("is false when both halves are the same host by address", () => {
    expect(isCrossSite("https://192.168.0.1", "https://192.168.0.1")).toBe(false);
  });
});
