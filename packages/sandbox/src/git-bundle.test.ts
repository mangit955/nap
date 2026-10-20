import { describe, expect, it } from "vitest";
import { decodeRepositoryBundle, encodeRepositoryBundle } from "./git-bundle.ts";

describe("repository bundle metadata", () => {
  const bytes = Buffer.from("# v2 git bundle\n\nPACK\0\xff");

  it("preserves the exact branch when several refs share a commit", () => {
    const result = decodeRepositoryBundle(encodeRepositoryBundle(bytes, "refs/heads/nap/job"));
    expect(result).toEqual({ ok: true, value: { bundle: bytes, head: "refs/heads/nap/job" } });
  });

  it("reads snapshots saved before branch metadata existed", () => {
    expect(decodeRepositoryBundle(bytes)).toEqual({
      ok: true,
      value: { bundle: bytes, head: null },
    });
  });

  it.each(["../../HEAD", "refs/heads/main\nmalicious", "", "--upload-pack=evil"])(
    "rejects malformed saved HEAD %j before shelling out",
    (head) => {
      const envelope = Buffer.concat([
        Buffer.from(`# nap snapshot v1\n${JSON.stringify({ head })}\n`),
        bytes,
      ]);
      expect(decodeRepositoryBundle(envelope).ok).toBe(false);
    },
  );

  it("refuses a truncated envelope", () => {
    expect(decodeRepositoryBundle(Buffer.from('# nap snapshot v1\n{"head":')).ok).toBe(false);
  });
});
