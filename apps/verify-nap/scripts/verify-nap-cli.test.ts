import { describe, expect, it } from "vitest";
import { chooseRun, evidenceName, parseCommand, RunFileSchema } from "./verify-nap-cli.ts";

describe("parseCommand", () => {
  it("reads a role and an accessible name for click", () => {
    expect(parseCommand(["click", "--role", "button", "--name", "Sign in"])).toEqual({
      ok: true,
      value: {
        kind: "click",
        target: { role: "button", name: "Sign in", exact: true },
        right: false,
      },
    });
  });

  it("reads a right click, which opens a session's context menu", () => {
    const parsed = parseCommand([
      "click",
      "--role",
      "link",
      "--name",
      "Seeded",
      "--loose",
      "--right",
    ]);
    expect(parsed.ok && parsed.value).toMatchObject({ kind: "click", right: true });
  });

  it("reads hover like click, for controls a row only shows under the pointer", () => {
    expect(parseCommand(["hover", "--role", "link", "--name", "Recipe Box", "--loose"])).toEqual({
      ok: true,
      value: { kind: "hover", target: { role: "link", name: "Recipe Box", exact: false } },
    });
  });

  it("accepts --flag=value and a loose name match", () => {
    expect(parseCommand(["click", "--role=link", "--name=Seeded", "--loose"])).toEqual({
      ok: true,
      value: {
        kind: "click",
        target: { role: "link", name: "Seeded", exact: false },
        right: false,
      },
    });
  });

  it("reads fill with its value, and refuses it without one", () => {
    expect(
      parseCommand(["fill", "--role", "textbox", "--name", "Email", "--value", "a@b.c"]),
    ).toEqual({
      ok: true,
      value: {
        kind: "fill",
        target: { role: "textbox", name: "Email", exact: true },
        value: "a@b.c",
      },
    });
    expect(parseCommand(["fill", "--role", "textbox", "--name", "Email"]).ok).toBe(false);
  });

  it("refuses a role nobody can query", () => {
    const parsed = parseCommand(["click", "--role", "buton", "--name", "Go"]);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toContain("buton");
  });

  it("reads wait by role or by text, with a state and a timeout", () => {
    expect(parseCommand(["wait", "--text", "Done.", "--timeout", "5000"])).toEqual({
      ok: true,
      value: { kind: "wait", target: { text: "Done." }, state: "visible", timeoutMs: 5000 },
    });
    expect(
      parseCommand(["wait", "--role", "button", "--name", "Stop", "--state", "hidden"]),
    ).toEqual({
      ok: true,
      value: {
        kind: "wait",
        target: { role: "button", name: "Stop", exact: true },
        state: "hidden",
        timeoutMs: 30_000,
      },
    });
    expect(parseCommand(["wait"]).ok).toBe(false);
  });

  it("requires a label for evidence, so a file says what it shows", () => {
    expect(parseCommand(["shot"]).ok).toBe(false);
    expect(parseCommand(["shot", "--label", "chat after steer", "--full"])).toEqual({
      ok: true,
      value: { kind: "shot", label: "chat after steer", fullPage: true },
    });
  });

  it("reads goto with a path, and refuses an absolute URL elsewhere", () => {
    expect(parseCommand(["goto", "/dashboard"])).toEqual({
      ok: true,
      value: { kind: "goto", path: "/dashboard" },
    });
    expect(parseCommand(["goto", "https://example.com"]).ok).toBe(false);
  });

  it("scopes a target or a snapshot to an iframe by its title", () => {
    expect(
      parseCommand(["click", "--role", "button", "--name", "Add note", "--frame", "App preview"]),
    ).toEqual({
      ok: true,
      value: {
        kind: "click",
        target: { role: "button", name: "Add note", exact: true, frame: "App preview" },
        right: false,
      },
    });
    expect(parseCommand(["snapshot", "--label", "preview", "--frame", "App preview"])).toEqual({
      ok: true,
      value: { kind: "snapshot", label: "preview", frame: "App preview" },
    });
  });

  it("takes a value that starts with -- as the value, not as a flag", () => {
    expect(
      parseCommand(["fill", "--role", "textbox", "--name", "Message", "--value", "--foo"]),
    ).toEqual({
      ok: true,
      value: {
        kind: "fill",
        target: { role: "textbox", name: "Message", exact: true },
        value: "--foo",
      },
    });
  });

  it("refuses an unknown flag and a flag missing its value", () => {
    const typo = parseCommand(["click", "--role", "button", "--name", "Go", "--lose"]);
    expect(!typo.ok && typo.error).toContain("--lose");
    expect(parseCommand(["click", "--role", "button", "--name"]).ok).toBe(false);
  });

  it("names the command it does not know", () => {
    const parsed = parseCommand(["tap"]);
    expect(!parsed.ok && parsed.error).toContain("tap");
  });
});

describe("evidenceName", () => {
  it("numbers files in capture order and makes the label a safe filename", () => {
    expect(evidenceName(["01-sign-in.png", "01-sign-in.aria.yml"], "Chat / after steer!")).toBe(
      "02-chat-after-steer",
    );
    expect(evidenceName([], "dashboard")).toBe("01-dashboard");
  });

  it("keeps counting past 99, and names a label with no letters", () => {
    expect(evidenceName(["99-a.png", "100-b.png"], "c")).toBe("101-c");
    expect(evidenceName([], "!!!")).toBe("01-capture");
  });
});

describe("chooseRun", () => {
  it("takes the one live run", () => {
    expect(chooseRun([{ directory: "a", state: "live" }], "click")).toEqual({
      ok: true,
      value: "a",
    });
  });

  it("refuses to choose between two live runs, and lists them", () => {
    const chosen = chooseRun(
      [
        { directory: "a", state: "live" },
        { directory: "b", state: "live" },
      ],
      "stop",
    );
    expect(chosen.ok).toBe(false);
    expect(!chosen.ok && chosen.error).toContain("b");
  });

  it("lets only stop reach a run that died without cleaning up", () => {
    const found = [{ directory: "dead", state: "stale" as const }];
    expect(chooseRun(found, "stop")).toEqual({ ok: true, value: "dead" });
    const click = chooseRun(found, "click");
    expect(!click.ok && click.error).toContain("stop");
  });
});

describe("RunFileSchema", () => {
  it("rejects a run file missing what the driver needs", () => {
    expect(RunFileSchema.safeParse({ pid: 1 }).success).toBe(false);
  });
});
