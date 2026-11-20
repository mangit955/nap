/**
 * No compiled component keeps a clock or a random number from its first render.
 *
 * React Compiler stores what a component computes in a per-component cache. A value with no
 * inputs goes in a block that runs once per mount: `if ($[n] === Symbol.for(
 * "react.memo_cache_sentinel")) { … }`. A `Date.now()` the source reads during render lands
 * there and is never read again, with no warning from the compiler and nothing a test that mounts
 * once can see. The chat's "Working for" clock did exactly that, counting a second turn from the
 * first one's start. The fix is a `"use no memo"` directive on the function. This test compiles
 * apps/web the way `next build` does and finds any such read still inside a once-per-mount block.
 *
 * The same blindness has a second shape: state whose value is thrown away (`const [, setTick] =
 * useState(0)`) and set on a timer only to make the component render again. Compiled, that render
 * reuses everything, because nothing it reads changed. GitHub's "Last fetched: just now" stopped
 * aging that way. The clock has to be state the render reads.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { type types as t, transformSync, traverse } from "@babel/core";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..");
const webSource = join(repoRoot, "apps/web/src");

/** Sources Next compiles for the browser: not tests, not test helpers, not `app/` (server). */
function browserSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      return ["app", "testing"].includes(entry.name) && directory === webSource
        ? []
        : browserSources(path);
    return /\.tsx?$/.test(entry.name) && !/\.(test|d)\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const isSentinelCheck = (node: t.Node): boolean =>
  node.type === "BinaryExpression" &&
  node.operator === "===" &&
  node.right.type === "CallExpression" &&
  node.right.arguments[0]?.type === "StringLiteral" &&
  node.right.arguments[0].value === "react.memo_cache_sentinel";

const isMember = (node: t.Node, object: string, property: string): boolean =>
  node.type === "MemberExpression" &&
  node.object.type === "Identifier" &&
  node.object.name === object &&
  node.property.type === "Identifier" &&
  node.property.name === property;

/** A call whose answer changes from one render to the next although nothing it reads did. */
function isImpure(node: t.Node): boolean {
  if (node.type === "NewExpression")
    return (
      node.callee.type === "Identifier" && node.callee.name === "Date" && !node.arguments.length
    );
  if (node.type !== "CallExpression") return false;
  return (
    isMember(node.callee, "Date", "now") ||
    isMember(node.callee, "performance", "now") ||
    isMember(node.callee, "Math", "random") ||
    isMember(node.callee, "crypto", "randomUUID")
  );
}

/** `file:line` of every impure read the compiler placed in a once-per-mount block. */
function cachedImpureReads(file: string, source: string): string[] {
  const result = transformSync(source, {
    filename: file,
    babelrc: false,
    configFile: false,
    ast: true,
    code: false,
    parserOpts: { plugins: ["typescript", "jsx"] },
    plugins: [["babel-plugin-react-compiler", { panicThreshold: "none" }]],
  });
  const found = new Set<string>();
  if (!result?.ast) return [];
  const at = (node: t.Node) => `${relative(repoRoot, file)}:${node.loc?.start.line ?? "?"}`;
  traverse(result.ast, {
    IfStatement(path) {
      if (!isSentinelCheck(path.node.test)) return;
      const render = path.getFunctionParent();
      path.get("consequent").traverse({
        // A call made while the block runs is read once per mount. One inside a closure the block
        // builds runs when the closure is called, which is fine.
        CallExpression(inner) {
          if (isImpure(inner.node) && inner.getFunctionParent() === render)
            found.add(at(inner.node));
        },
        NewExpression(inner) {
          if (isImpure(inner.node) && inner.getFunctionParent() === render)
            found.add(at(inner.node));
        },
        // But a closure that captures a value read in render keeps the first render's value: the
        // block is not run again when the clock moves, because the clock is not a dependency.
        ReferencedIdentifier(inner) {
          const binding = inner.scope.getBinding(inner.node.name);
          const declared = binding?.path.node;
          if (
            declared?.type === "VariableDeclarator" &&
            declared.init &&
            isImpure(declared.init) &&
            // Read by the render itself, not by a handler for its own use or once per module.
            binding?.path.getFunctionParent() === render
          )
            found.add(at(inner.node));
        },
      });
    },
  });
  return [...found];
}

/**
 * `file:line` of every discarded state value (`const [, set] = useState(…)` or `useReducer`) in a
 * function the compiler compiled. A function it refused runs as written, where forcing a render
 * still works.
 */
function forcedRendersInCompiledCode(file: string, source: string): string[] {
  const discarded = [
    ...source.matchAll(/const \[\s*,\s*\w+\s*\]\s*=\s*use(?:State|Reducer)\b/g),
  ].map((match) => source.slice(0, match.index).split("\n").length);
  if (discarded.length === 0) return [];
  const compiled: { start: number; end: number }[] = [];
  transformSync(source, {
    filename: file,
    babelrc: false,
    configFile: false,
    code: false,
    parserOpts: { plugins: ["typescript", "jsx"] },
    plugins: [
      [
        "babel-plugin-react-compiler",
        {
          panicThreshold: "none",
          logger: {
            logEvent(_file: string, event: { kind: string; fnLoc?: t.SourceLocation | null }) {
              if (event.kind === "CompileSuccess" && event.fnLoc)
                compiled.push({ start: event.fnLoc.start.line, end: event.fnLoc.end.line });
            },
          },
        },
      ],
    ],
  });
  return discarded
    .filter((line) => compiled.some(({ start, end }) => start <= line && line <= end))
    .map((line) => `${relative(repoRoot, file)}:${line}`);
}

describe("React Compiler and what a render reads", () => {
  it("finds a clock read the compiler would keep from the first render", () => {
    // The shape of the bug this guards: a hook reading the clock while rendering.
    const source = `
      import { useState } from "react";
      export function useSince(working, key) {
        const [since, setSince] = useState(undefined);
        let next = since;
        if (!working) next = undefined;
        else if (since === undefined || since.key !== key) next = { at: Date.now(), key };
        if (next !== since) setSince(next);
        return next?.at;
      }`;
    expect(cachedImpureReads(join(webSource, "probe.ts"), source)).toHaveLength(1);
  });

  it("finds a clock read that a cached closure captures", () => {
    // The filter is built once per mount, so it keeps comparing against the first render's time.
    const source = `
      export function Live({ items }) {
        const now = Date.now();
        const isLive = (item) => item.expiresAt > now;
        return <List items={items} isLive={isLive} />;
      }`;
    expect(cachedImpureReads(join(webSource, "probe.tsx"), source)).toHaveLength(1);
  });

  it("leaves a closure that reads the clock when it is called", () => {
    // Both closures land in a once-per-mount block (they capture only a state setter), and both
    // read the clock when clicked, which is right.
    const source = `
      import { useState } from "react";
      export function Stamp() {
        const [at, setAt] = useState(0);
        const stamp = () => setAt(Date.now());
        const stampLocal = () => {
          const t = Date.now();
          setAt(t);
        };
        return <Buttons at={at} stamp={stamp} stampLocal={stampLocal} />;
      }`;
    expect(cachedImpureReads(join(webSource, "probe.tsx"), source)).toEqual([]);
  });

  it("finds state kept only to force a render in compiled code", () => {
    const source = `
      import { useEffect, useState } from "react";
      export function Fetched({ at }) {
        const [, setTick] = useState(0);
        useEffect(() => {
          const timer = setInterval(() => setTick((value) => value + 1), 30_000);
          return () => clearInterval(timer);
        }, []);
        return <p>{ago(at)}</p>;
      }`;
    expect(forcedRendersInCompiledCode(join(webSource, "probe.tsx"), source)).toHaveLength(1);
  });

  it("finds no state kept only to force a render in the web app's compiled code", () => {
    const found = browserSources(webSource).flatMap((file) =>
      forcedRendersInCompiledCode(file, readFileSync(file, "utf8")),
    );
    expect(found).toEqual([]);
  }, 60_000);

  it("finds none in the web app", () => {
    const found = browserSources(webSource).flatMap((file) =>
      cachedImpureReads(file, readFileSync(file, "utf8")),
    );
    expect(found).toEqual([]);
  }, 60_000);
});
