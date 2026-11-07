import { describe, expect, it } from "vitest";
import type { FileNode, SandboxError, SandboxManager } from "./ports/sandbox-manager.ts";
import type { Result } from "./result.ts";
import {
  discoverSkills,
  MAX_SKILL_CHARS,
  MAX_SKILL_DESCRIPTION,
  MAX_SKILLS,
  parseSkill,
  readAllowedTools,
  skillsDiscoveredPayload,
  skillsUnchanged,
} from "./skills.ts";

const ROOT = "/home/user/app";

function skillFile(fields: string, body = "Do the thing carefully."): string {
  return `---\n${fields}\n---\n\n${body}\n`;
}

describe("parseSkill", () => {
  const at = `${ROOT}/.nap/skills/migrations/SKILL.md`;

  it("reads the name, the description and the body", () => {
    const parsed = parseSkill(
      at,
      skillFile("name: migrations\ndescription: How to add a database migration"),
    );
    expect(parsed).toEqual({
      ok: true,
      value: {
        name: "migrations",
        description: "How to add a database migration",
        path: at,
        directory: `${ROOT}/.nap/skills/migrations`,
        allowedTools: null,
        body: "Do the thing carefully.",
      },
    });
  });

  it("ignores keys it does not use, as other harnesses write them", () => {
    const parsed = parseSkill(
      at,
      skillFile("name: migrations\ndescription: d\nlicense: MIT\nmetadata:\n  version: 2"),
    );
    expect(parsed.ok).toBe(true);
  });

  it("accepts a folded description and Windows line endings", () => {
    const text = "---\r\nname: x\r\ndescription: >\r\n  one\r\n  two\r\n---\r\nBody\r\n";
    const parsed = parseSkill(at, text);
    expect(parsed.ok && parsed.value.description).toBe("one two");
    expect(parsed.ok && parsed.value.body).toBe("Body");
  });

  it.each([
    ["no frontmatter", "# Just a heading\n\nText", /frontmatter/],
    ["unterminated frontmatter", "---\nname: x\ndescription: y\n", /frontmatter/],
    ["invalid YAML", skillFile("name: [unclosed\ndescription: y"), /YAML/],
    ["a list, not a mapping", skillFile("- name\n- description"), /mapping/],
    ["no name", skillFile("description: y"), /name/],
    ["a name with a slash", skillFile("name: ../escape\ndescription: y"), /name/],
    ["an empty description", skillFile("name: x\ndescription: '  '"), /description/],
    [
      "an overlong description",
      skillFile(`name: x\ndescription: ${"d".repeat(MAX_SKILL_DESCRIPTION + 1)}`),
      /description/,
    ],
    ["no body", skillFile("name: x\ndescription: y", "   "), /no instructions/],
    [
      "an oversized file",
      skillFile("name: x\ndescription: y", "b".repeat(MAX_SKILL_CHARS)),
      /characters/,
    ],
  ])("skips %s with a reason", (_case, text, reason) => {
    const parsed = parseSkill(at, text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(reason);
  });

  it("keeps allowed-tools as the entries it listed", () => {
    const parsed = parseSkill(at, skillFile("name: x\ndescription: y\nallowed-tools: Read, Grep"));
    expect(parsed.ok && parsed.value.allowedTools).toEqual(["Read", "Grep"]);
  });
});

describe("readAllowedTools", () => {
  it("maps the common harness names onto Nap's tools", () => {
    expect(readAllowedTools(["Read", "Grep", "Glob", "LS"])).toEqual({
      tools: ["read_file", "list_files", "search_files", "glob"],
      ignored: [],
    });
  });

  it("accepts Nap's own names, and one entry may stand for several tools", () => {
    const { tools } = readAllowedTools(["read_file", "Bash"]);
    expect(tools).toEqual([
      "read_file",
      "run_command",
      "shell_output",
      "shell_input",
      "shell_kill",
    ]);
  });

  it("splits a single string on commas or spaces, keeping a scoped entry whole", () => {
    expect(readAllowedTools("Read Bash(git status:*)").ignored).toEqual(["Bash(git status:*)"]);
    expect(readAllowedTools("Read,Edit").tools).toEqual(["read_file", "edit_file", "apply_patch"]);
  });

  it("grants nothing for a name it does not know or a scope it cannot enforce", () => {
    expect(readAllowedTools(["WebFetch", "Bash(npm:*)", "sudo"])).toEqual({
      tools: [],
      ignored: ["WebFetch", "Bash(npm:*)", "sudo"],
    });
  });
});

/** A sandbox holding these files, answering only what discovery is allowed to ask. */
function sandboxWith(
  files: Record<string, string>,
  failures: { list?: SandboxError; read?: Record<string, SandboxError> } = {},
): SandboxManager & { calls: string[] } {
  const calls: string[] = [];
  const listFiles = async (
    _id: string,
    path: string,
  ): Promise<Result<FileNode[], SandboxError>> => {
    calls.push(`list ${path}`);
    if (failures.list !== undefined) return { ok: false, error: failures.list };
    const prefix = `${path}/`;
    const children = new Map<string, FileNode["type"]>();
    for (const file of Object.keys(files)) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      const slash = rest.indexOf("/");
      children.set(
        prefix + (slash === -1 ? rest : rest.slice(0, slash)),
        slash === -1 ? "file" : "directory",
      );
    }
    if (children.size === 0) return { ok: false, error: { code: "file_not_found", message: path } };
    return { ok: true, value: [...children].map(([p, type]) => ({ path: p, type })) };
  };
  const readFile = async (_id: string, path: string): Promise<Result<string, SandboxError>> => {
    calls.push(`read ${path}`);
    const failure = failures.read?.[path];
    if (failure !== undefined) return { ok: false, error: failure };
    const contents = files[path];
    return contents === undefined
      ? { ok: false, error: { code: "file_not_found", message: path } }
      : { ok: true, value: contents };
  };
  const refuse = () => {
    throw new Error("discovery may only list and read");
  };
  return {
    calls,
    listFiles,
    readFile,
    create: refuse,
    resume: refuse,
    destroy: refuse,
    extendTimeout: refuse,
    writeFile: refuse,
    writeFileBytes: refuse,
    readFileBytes: refuse,
    listTree: refuse,
    exec: refuse,
    getPreviewUrl: refuse,
    waitForPreview: refuse,
  };
}

describe("discoverSkills", () => {
  it("finds a skill under each convention, Nap's own first", async () => {
    const sandbox = sandboxWith({
      [`${ROOT}/.claude/skills/review/SKILL.md`]: skillFile("name: review\ndescription: c"),
      [`${ROOT}/.agents/skills/deploy/SKILL.md`]: skillFile("name: deploy\ndescription: b"),
      [`${ROOT}/.nap/skills/style/SKILL.md`]: skillFile("name: style\ndescription: a"),
    });
    const index = await discoverSkills(sandbox, "sbx", ROOT);
    expect(index.skills.map((skill) => skill.name)).toEqual(["style", "deploy", "review"]);
    expect(index.skipped).toEqual([]);
    expect(index.unavailable).toBeUndefined();
  });

  it("reads each skill folder once, and nothing else", async () => {
    const sandbox = sandboxWith({
      [`${ROOT}/.nap/skills/style/SKILL.md`]: skillFile("name: style\ndescription: a"),
      [`${ROOT}/.nap/skills/style/examples.md`]: "not a skill",
      [`${ROOT}/src/SKILL.md`]: skillFile("name: elsewhere\ndescription: a"),
    });
    await discoverSkills(sandbox, "sbx", ROOT);
    expect(sandbox.calls.filter((call) => call.startsWith("read"))).toEqual([
      `read ${ROOT}/.nap/skills/style/SKILL.md`,
    ]);
  });

  it("passes over a folder with no SKILL.md in silence", async () => {
    const sandbox = sandboxWith({ [`${ROOT}/.claude/skills/shared/notes.md`]: "notes" });
    expect(await discoverSkills(sandbox, "sbx", ROOT)).toEqual({ skills: [], skipped: [] });
  });

  it("keeps the first of two skills with one name, and says why the second went", async () => {
    const sandbox = sandboxWith({
      [`${ROOT}/.nap/skills/style/SKILL.md`]: skillFile("name: style\ndescription: ours"),
      [`${ROOT}/.claude/skills/style/SKILL.md`]: skillFile("name: style\ndescription: theirs"),
    });
    const index = await discoverSkills(sandbox, "sbx", ROOT);
    expect(index.skills.map((skill) => skill.description)).toEqual(["ours"]);
    expect(index.skipped).toEqual([
      {
        path: `${ROOT}/.claude/skills/style/SKILL.md`,
        reason: `another skill named style is already defined at ${ROOT}/.nap/skills/style/SKILL.md`,
      },
    ]);
  });

  it("skips a malformed skill with its reason and keeps the rest", async () => {
    const sandbox = sandboxWith({
      [`${ROOT}/.nap/skills/broken/SKILL.md`]: "no frontmatter here",
      [`${ROOT}/.nap/skills/fine/SKILL.md`]: skillFile("name: fine\ndescription: ok"),
    });
    const index = await discoverSkills(sandbox, "sbx", ROOT);
    expect(index.skills.map((skill) => skill.name)).toEqual(["fine"]);
    expect(index.skipped).toHaveLength(1);
    expect(index.skipped[0]?.path).toBe(`${ROOT}/.nap/skills/broken/SKILL.md`);
  });

  it(`reads at most ${MAX_SKILLS} skills, and names the rest as skipped`, async () => {
    const files: Record<string, string> = {};
    for (let n = 0; n < MAX_SKILLS + 2; n += 1) {
      const name = `s${String(n).padStart(2, "0")}`;
      files[`${ROOT}/.nap/skills/${name}/SKILL.md`] = skillFile(`name: ${name}\ndescription: d`);
    }
    const sandbox = sandboxWith(files);
    const index = await discoverSkills(sandbox, "sbx", ROOT);
    expect(index.skills).toHaveLength(MAX_SKILLS);
    expect(index.skipped.map((skip) => skip.path)).toEqual([
      `${ROOT}/.nap/skills/s32/SKILL.md`,
      `${ROOT}/.nap/skills/s33/SKILL.md`,
    ]);
    expect(sandbox.calls.filter((call) => call.startsWith("read"))).toHaveLength(MAX_SKILLS);
  });

  it("reports a sandbox that cannot answer as unavailable, never as an empty project", async () => {
    const sandbox = sandboxWith({}, { list: { code: "unavailable", message: "down" } });
    const index = await discoverSkills(sandbox, "sbx", ROOT);
    expect(index.skills).toEqual([]);
    expect(index.unavailable).toMatch(/unavailable/);
  });

  it("skips one skill that could not be read, with the reason", async () => {
    const path = `${ROOT}/.nap/skills/style/SKILL.md`;
    const sandbox = sandboxWith(
      { [path]: skillFile("name: style\ndescription: a") },
      { read: { [path]: { code: "timeout", message: "slow" } } },
    );
    const index = await discoverSkills(sandbox, "sbx", ROOT);
    expect(index.skipped).toEqual([{ path, reason: "could not be read (timeout: slow)" }]);
  });

  it("gives up at its deadline rather than holding the turn", async () => {
    const sandbox = sandboxWith({});
    sandbox.listFiles = () => new Promise(() => {});
    const index = await discoverSkills(sandbox, "sbx", ROOT, { timeoutMs: 5 });
    expect(index.unavailable).toMatch(/did not answer/);
  });

  it("does not throw when the sandbox does", async () => {
    const sandbox = sandboxWith({});
    sandbox.listFiles = () => Promise.reject(new Error("boom"));
    const index = await discoverSkills(sandbox, "sbx", ROOT);
    expect(index.unavailable).toMatch(/boom/);
  });
});

describe("skillsDiscoveredPayload and skillsUnchanged", () => {
  const index = {
    skills: [
      {
        name: "style",
        description: "a",
        path: `${ROOT}/.nap/skills/style/SKILL.md`,
        directory: `${ROOT}/.nap/skills/style`,
        allowedTools: null,
      },
    ],
    skipped: [{ path: `${ROOT}/.nap/skills/x/SKILL.md`, reason: "r" }],
  };

  it("records what a reader needs and nothing a later read would change", () => {
    expect(skillsDiscoveredPayload(index)).toEqual({
      skills: [{ name: "style", description: "a", path: `${ROOT}/.nap/skills/style/SKILL.md` }],
      skipped: [{ path: `${ROOT}/.nap/skills/x/SKILL.md`, reason: "r" }],
    });
  });

  it("is unchanged against the same payload and changed against any difference", () => {
    const payload = skillsDiscoveredPayload(index);
    expect(skillsUnchanged(payload, payload)).toBe(true);
    expect(skillsUnchanged(payload, { ...payload, skipped: [] })).toBe(false);
    expect(skillsUnchanged(undefined, { skills: [], skipped: [] })).toBe(true);
    expect(skillsUnchanged(undefined, payload)).toBe(false);
  });
});
