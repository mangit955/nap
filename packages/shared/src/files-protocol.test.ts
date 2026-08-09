import { describe, expect, it } from "vitest";
import {
  FileContentSchema,
  FileListingSchema,
  PROJECT_ROOT_PATH,
  ProjectPathSchema,
  toProjectPath,
} from "./files-protocol.ts";

describe("toProjectPath", () => {
  it("strips the sandbox's project root", () => {
    expect(toProjectPath(`${PROJECT_ROOT_PATH}/src/App.tsx`)).toBe("src/App.tsx");
  });

  it("leaves a path that is already relative alone", () => {
    expect(toProjectPath("src/App.tsx")).toBe("src/App.tsx");
  });

  it("produces something the path schema accepts", () => {
    // What comes out of here is matched against a listing and used as a key, so it has to be
    // in the same shape the endpoints speak.
    expect(
      ProjectPathSchema.safeParse(toProjectPath(`${PROJECT_ROOT_PATH}/index.html`)).success,
    ).toBe(true);
  });

  it("does not strip a prefix that merely looks like the root", () => {
    expect(toProjectPath("/home/user/apparel/x.ts")).toBe("/home/user/apparel/x.ts");
  });
});

describe("ProjectPathSchema", () => {
  it("accepts an ordinary project path", () => {
    expect(ProjectPathSchema.safeParse("src/components/Header.tsx").success).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["absolute", "/etc/passwd"],
    ["escaping the project", "../../etc/passwd"],
    ["escaping from inside", "src/../../secrets"],
    ["carrying a null byte", "src/App.tsx\0.png"],
    ["doubly separated", "src//App.tsx"],
    ["carrying a dot segment", "src/./App.tsx"],
    ["trailing a separator", "src/"],
  ])("refuses a path that is %s", (_name, path) => {
    expect(ProjectPathSchema.safeParse(path).success).toBe(false);
  });

  it("allows a dotfile, which is not the same as a dot segment", () => {
    // `.env.example` and `.gitignore` are project files someone may well want to read; it is
    // `..` as a whole segment that leaves the project.
    expect(ProjectPathSchema.safeParse(".gitignore").success).toBe(true);
    expect(ProjectPathSchema.safeParse("src/..hidden.ts").success).toBe(true);
  });
});

describe("FileListingSchema", () => {
  it("round-trips through JSON, which is how it travels", () => {
    const listing = { ready: true, files: ["index.html", "src/App.tsx"], truncated: false };

    expect(FileListingSchema.parse(JSON.parse(JSON.stringify(listing)))).toEqual(listing);
  });

  it("refuses a listing carrying a path outside the project", () => {
    const listing = { ready: true, files: ["../../etc/passwd"], truncated: false };

    expect(FileListingSchema.safeParse(listing).success).toBe(false);
  });

  it("refuses an unknown key, so a producer bug is caught at the boundary", () => {
    const listing = { ready: true, files: [], truncated: false, sandboxId: "sbx_1" };

    expect(FileListingSchema.safeParse(listing).success).toBe(false);
  });
});

describe("FileContentSchema", () => {
  it("round-trips through JSON", () => {
    const content = { path: "src/App.tsx", contents: "export default null;\n", bytes: 21 };

    expect(FileContentSchema.parse({ ...content, truncated: false })).toEqual({
      ...content,
      truncated: false,
    });
  });

  it("accepts an empty file but not a negative size", () => {
    expect(
      FileContentSchema.safeParse({ path: "empty.txt", contents: "", truncated: false, bytes: 0 })
        .success,
    ).toBe(true);
    expect(
      FileContentSchema.safeParse({ path: "a.txt", contents: "", truncated: false, bytes: -1 })
        .success,
    ).toBe(false);
  });
});
