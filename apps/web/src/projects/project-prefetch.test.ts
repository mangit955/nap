import { beforeEach, describe, expect, it } from "vitest";
import { forgetPrefetchedProject, prefetchProject, readProject } from "./project-prefetch.ts";

const BASE = "http://api.test";
const PROJECT = "3e0fbc41-6f5d-4a8e-ab9c-4d5e6f708192";
const URL_ = `${BASE}/projects/${PROJECT}`;

/** A server that counts what it was asked, and answers with the status the test sets. */
function server(status = 200) {
  const asked: string[] = [];
  const fetchJson = async (url: string) => {
    asked.push(url);
    return new Response(JSON.stringify({ projectId: PROJECT }), { status });
  };
  return { asked, fetchJson };
}

beforeEach(() => forgetPrefetchedProject());

describe("reading a project that was asked for early", () => {
  it("uses the early answer, once, without asking again", async () => {
    const early = server();
    prefetchProject(PROJECT, { baseUrl: BASE, fetchJson: early.fetchJson });
    const late = server();

    const response = await readProject(URL_, late.fetchJson);

    expect(response.status).toBe(200);
    expect(early.asked).toEqual([URL_]);
    expect(late.asked).toEqual([]);
    // A second read — a refresh — is a real request, never the same early answer again.
    await readProject(URL_, late.fetchJson);
    expect(late.asked).toEqual([URL_]);
  });

  it("asks once however many times the same project is asked for early", () => {
    // Strict Mode runs the effect that asks twice.
    const early = server();
    prefetchProject(PROJECT, { baseUrl: BASE, fetchJson: early.fetchJson });
    prefetchProject(PROJECT, { baseUrl: BASE, fetchJson: early.fetchJson });

    expect(early.asked).toHaveLength(1);
  });

  it("asks again when the early answer was a refusal", async () => {
    // Asked before anybody knew whether there was a session: a 401 then says nothing about now.
    prefetchProject(PROJECT, { baseUrl: BASE, fetchJson: server(401).fetchJson });
    const late = server();

    const response = await readProject(URL_, late.fetchJson);

    expect(response.status).toBe(200);
    expect(late.asked).toEqual([URL_]);
  });

  it("asks again when the early answer failed to arrive at all", async () => {
    prefetchProject(PROJECT, {
      baseUrl: BASE,
      fetchJson: async () => {
        throw new TypeError("offline");
      },
    });
    const late = server();

    expect((await readProject(URL_, late.fetchJson)).status).toBe(200);
    expect(late.asked).toEqual([URL_]);
  });

  it("does not use an early answer for another project", async () => {
    prefetchProject("4e0fbc41-6f5d-4a8e-ab9c-4d5e6f708192", {
      baseUrl: BASE,
      fetchJson: server().fetchJson,
    });
    const late = server();

    await readProject(URL_, late.fetchJson);

    expect(late.asked).toEqual([URL_]);
  });

  it("does not use an early answer that has gone stale", async () => {
    let now = 1_000;
    prefetchProject(PROJECT, { baseUrl: BASE, fetchJson: server().fetchJson, now: () => now });
    now += 60_000;
    const late = server();

    await readProject(URL_, late.fetchJson, () => now);

    expect(late.asked).toEqual([URL_]);
  });
});
