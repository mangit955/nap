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

describe("React Compiler and impure reads in render", () => {
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

  it("finds none in the web app", () => {
    const found = browserSources(webSource).flatMap((file) =>
      cachedImpureReads(file, readFileSync(file, "utf8")),
    );
    expect(found).toEqual([]);
  }, 60_000);
});
