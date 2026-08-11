import { describe, expect, it } from "vitest";
import { idsFromRequest } from "./log-ids.ts";

const SESSION = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";
const PROJECT = "9c1d2e3f-4a5b-6c7d-8e9f-0a1b2c3d4e5f";

describe("idsFromRequest", () => {
  it("reads a session id out of the path", () => {
    // The case the request-context middleware exists for: every turn, cancel and file request
    // names its session in the path, and none of them names it in the query.
    expect(idsFromRequest(new URL(`http://api/sessions/${SESSION}/turns`))).toEqual({
      sessionId: SESSION,
    });
  });

  it("reads a project id out of the path", () => {
    expect(idsFromRequest(new URL(`http://api/projects/${PROJECT}/close`))).toEqual({
      projectId: PROJECT,
    });
  });

  it("reads a session id out of the query, which is how the stream names one", () => {
    expect(idsFromRequest(new URL(`http://api/ws?sessionId=${SESSION}&seq=3`))).toEqual({
      sessionId: SESSION,
    });
  });

  it("finds the id at the end of a path as well as in the middle", () => {
    expect(idsFromRequest(new URL(`http://api/projects/${PROJECT}`))).toEqual({
      projectId: PROJECT,
    });
  });

  it("finds nothing in a collection route", () => {
    expect(idsFromRequest(new URL("http://api/projects"))).toEqual({});
    expect(idsFromRequest(new URL("http://api/health"))).toEqual({});
  });

  it("ignores a segment that is not an id", () => {
    // Two reasons. A log line saying `projectId: "../../etc"` invites a reader to believe such
    // a project exists, and the ids are what someone greps by — a key holding something that
    // is not an id makes every search over it unreliable.
    expect(idsFromRequest(new URL("http://api/projects/not-a-uuid/close"))).toEqual({});
    expect(idsFromRequest(new URL("http://api/ws?sessionId=%2E%2E%2Fetc"))).toEqual({});
  });

  it("is case-insensitive about the id, since a uuid may be written either way", () => {
    expect(idsFromRequest(new URL(`http://api/projects/${PROJECT.toUpperCase()}`))).toEqual({
      projectId: PROJECT.toUpperCase(),
    });
  });

  it("reads both when a path names one and the query names the other", () => {
    expect(idsFromRequest(new URL(`http://api/projects/${PROJECT}?sessionId=${SESSION}`))).toEqual({
      projectId: PROJECT,
      sessionId: SESSION,
    });
  });
});
