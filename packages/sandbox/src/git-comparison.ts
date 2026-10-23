import { type GitComparison, GitComparisonSchema, type GitScope } from "@nap/shared/git-protocol";
import type { SandboxError, SandboxManager } from "@nap/shared/ports/sandbox-manager";
import type { Result } from "@nap/shared/result";
import { shellQuote } from "@nap/shared/shell";
import { z } from "zod";
import { TEMPLATE_WORKDIR } from "./template.ts";

// Executed inside the sandbox. Argument arrays keep paths and refs out of the shell.
export const COMPARISON_SCRIPT = String.raw`
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const [scope, requestedBase] = process.argv.slice(1);
const deadline = performance.now() + 20000;
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const timeLeft = () => {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining <= 0) fail('comparison_timeout');
  return remaining;
};
const runGit = (args, options = {}) => {
  const output = execFileSync('git', ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.quotePath=false', '-c', 'diff.autoRefreshIndex=false', '--no-pager', ...args], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options,
    timeout: timeLeft(), stdio: ['ignore', 'pipe', 'pipe'],
  });
  timeLeft();
  return output;
};
const git = (...args) => runGit(args);
try {
const head = git('rev-parse', 'HEAD').trim();
let base = head;
let baseLabel = 'HEAD';
if (scope === 'branch') {
  if (requestedBase) {
    try {
      const resolved = git('rev-parse', '--verify', '--end-of-options', requestedBase + '^{commit}').trim();
      base = git('merge-base', resolved, head).trim();
    } catch (error) {
      if (!error.code && [1, 128].includes(error.status)) fail('invalid_base');
      throw error;
    }
    baseLabel = requestedBase;
  } else {
    base = git('rev-list', '--max-parents=0', 'HEAD').trim().split('\n')[0];
    baseLabel = 'Initial commit';
  }
} else if (scope === 'commit') {
  try { base = git('rev-parse', 'HEAD^').trim(); }
  catch (error) {
    if (error.code || error.status !== 128) throw error;
    base = git('hash-object', '-t', 'tree', '--stdin').trim();
  }
  baseLabel = 'HEAD^';
}
const target = scope === 'commit' ? [head] : [];
const fs = scope === 'commit' ? null : require('node:fs');
const fingerprint = (path) => {
  timeLeft();
  try {
    const stat = fs.lstatSync(path, { bigint: true });
    return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return 'absent';
    throw error;
  }
};
const inventory = () => git('status', '--porcelain=v1', '-z', '--untracked-files=all');
const indexPath = fs ? git('rev-parse', '--git-path', 'index').trim() : null;
const indexBefore = fs ? fingerprint(indexPath) : null;
const statusBefore = fs ? inventory() : null;
const fields = git('diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', '-M', base, ...target, '--').split('\0');
const entries = [];
for (let i = 0; i < fields.length - 1;) {
  const status = fields[i++];
  const path = fields[i++];
  if (!status || !path) break;
  if (status[0] === 'R' || status[0] === 'C') entries.push({ status: status[0] === 'R' ? 'renamed' : 'copied', previousPath: path, path: fields[i++] });
  else entries.push({ status: ({ A: 'added', D: 'deleted', T: 'typechanged' })[status[0]] || 'modified', previousPath: null, path });
}
const recreated = new Set();
if (fs) {
  const byPath = new Map(entries.map(entry => [entry.path, entry]));
  for (const path of git('ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean)) {
    const existing = byPath.get(path);
    if (existing?.status === 'deleted') recreated.add(path);
    else if (!existing) {
      const entry = { status: 'untracked', previousPath: null, path };
      entries.push(entry);
      byPath.set(path, entry);
    }
  }
}
const candidates = entries.slice(0, 300);
const before = new Map();
if (fs) for (const entry of candidates) {
  before.set(entry.path, fingerprint(entry.path));
  if (entry.previousPath) before.set(entry.previousPath, fingerprint(entry.previousPath));
}
const noIndex = (args) => {
  try { return git(...args); }
  catch (error) {
    timeLeft();
    if (!error.code && error.status === 1) return String(error.stdout);
    throw error;
  }
};
// Isolate just the colliding pair. Git writes canonical a/ and b/ paths itself,
// including quoted names, binary markers and symlink/type-change patches.
const recreatedPatch = (entry) => {
  const { dirname, join } = require('node:path');
  const { tmpdir } = require('node:os');
  const treeEntry = git('ls-tree', '-z', base, '--', entry.path);
  const match = /^(100644|100755|120000) blob ([0-9a-f]+)\t/.exec(treeEntry);
  if (!match) fail('comparison_failed');
  const oldMode = match[1];
  const contents = runGit(['cat-file', 'blob', match[2]], { encoding: null });
  const current = fs.lstatSync(entry.path);
  if (!current.isFile() && !current.isSymbolicLink()) fail('repository_changed');
  entry.status = (oldMode === '120000') !== current.isSymbolicLink() ? 'typechanged' : 'modified';
  const directory = fs.mkdtempSync(join(tmpdir(), 'nap-compare-'));
  try {
    const oldPath = join('a', entry.path);
    const newPath = join('b', entry.path);
    fs.mkdirSync(dirname(join(directory, oldPath)), { recursive: true });
    fs.mkdirSync(dirname(join(directory, newPath)), { recursive: true });
    if (oldMode === '120000') fs.symlinkSync(contents.toString('utf8'), join(directory, oldPath));
    else fs.writeFileSync(join(directory, oldPath), contents, { mode: parseInt(oldMode, 8) & 0o777 });
    if (current.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(entry.path), join(directory, newPath));
    else {
      fs.copyFileSync(entry.path, join(directory, newPath));
      fs.chmodSync(join(directory, newPath), current.mode & 0o777);
    }
    let patch = noIndex(['-C', directory, 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-index', '--src-prefix=', '--dst-prefix=', '--', oldPath, newPath]);
    if (entry.status === 'typechanged') {
      // No-index emits two file sections for a type change. Keep both on the same
      // canonical path, retaining Git's own quoting for unusual filenames.
      const label = /^(?:---|\+\+\+) (?!\/dev\/null)(.+)$/m.exec(patch)?.[1]?.replace(/\t$/, '');
      if (label) {
        const oldLabel = label.replace(/^("?)[ab]\//, '$1a/');
        const newLabel = label.replace(/^("?)[ab]\//, '$1b/');
        patch = patch.replace(/^diff --git .+$/gm, () => 'diff --git ' + oldLabel + ' ' + newLabel);
      }
    }
    return patch;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
};
const hash = createHash('sha256').update(head).update(base);
let remaining = 384 * 1024;
let computed = 0;
const files = [];
for (const entry of candidates) {
  timeLeft();
  if (remaining <= 0) break;
  let patch = recreated.has(entry.path)
    ? recreatedPatch(entry)
    : entry.status === 'untracked'
      ? noIndex(['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-index', '--', '/dev/null', entry.path])
      : git('diff', '--no-ext-diff', '--no-textconv', '--no-color', '-M', '--unified=3', base, ...target, '--', ...(entry.previousPath ? [entry.previousPath] : []), entry.path);
  computed++;
  if (!patch) continue;
  hash.update(entry.path).update(patch);
  const binary = /^Binary files /m.test(patch);
  let additions = 0, deletions = 0, hunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) hunk = false;
    else if (line.startsWith('@@')) hunk = true;
    else if (hunk && line.startsWith('+')) additions++;
    else if (hunk && line.startsWith('-')) deletions++;
  }
  const limit = Math.min(120 * 1024, remaining);
  const bytes = Buffer.byteLength(patch);
  const truncated = bytes > limit;
  if (truncated) {
    patch = Buffer.from(patch).subarray(0, limit).toString('utf8');
    patch = patch.slice(0, Math.max(0, patch.lastIndexOf('\n')));
  }
  remaining -= Math.min(bytes, limit);
  files.push({ ...entry, additions, deletions, binary, truncated, patch });
}
if (fs) {
  if (inventory() !== statusBefore || fingerprint(indexPath) !== indexBefore) fail('repository_changed');
  for (const [path, stat] of before) if (fingerprint(path) !== stat) fail('repository_changed');
}
if (git('rev-parse', 'HEAD').trim() !== head) fail('repository_changed');
let branch = '';
try { branch = git('symbolic-ref', '--quiet', '--short', 'HEAD').trim(); }
catch (error) {
  if (error.code || error.status !== 1) throw error;
  branch = head.slice(0, 8);
}
const output = JSON.stringify({ ready: true, scope, base, head, baseLabel, branch, revision: hash.digest('hex'), capturedAt: new Date().toISOString(), truncated: entries.length > computed || files.some(file => file.truncated), files });
timeLeft();
process.stdout.write(output);
} catch (error) {
  const code = error.code === 'ETIMEDOUT' || error.code === 'comparison_timeout' ? 'comparison_timeout'
    : error.code === 'ENOBUFS' ? 'output_too_large'
    : ['ENOENT', 'ENOTDIR', 'repository_changed'].includes(error.code) ? 'repository_changed'
    : error.code === 'invalid_base' ? 'invalid_base' : 'comparison_failed';
  process.stdout.write(JSON.stringify({ comparisonError: code }));
  throw new Error(code === 'comparison_timeout' ? 'Comparison time limit exceeded' : code);
}
`;

const ComparisonFailure = z.object({
  comparisonError: z.enum([
    "comparison_timeout",
    "output_too_large",
    "repository_changed",
    "invalid_base",
    "comparison_failed",
  ]),
});
const failureMessages = {
  comparison_timeout: "The comparison reached its time limit. Try a smaller comparison or refresh.",
  output_too_large: "Git output is too large to compare safely. Try a smaller comparison.",
  repository_changed: "The repository changed while reading. Refresh to compare the latest files.",
  invalid_base: "Could not resolve the base branch. Check the base branch and refresh.",
  comparison_failed: "Could not compare the repository. Refresh to try again.",
} satisfies Record<z.infer<typeof ComparisonFailure>["comparisonError"], string>;

export async function compareGit(
  manager: SandboxManager,
  sandboxId: string,
  options: { scope: GitScope; base?: string; cwd?: string },
): Promise<Result<GitComparison, SandboxError>> {
  const result = await manager.exec(
    sandboxId,
    `cd ${shellQuote(options.cwd ?? TEMPLATE_WORKDIR)} && node -e ${shellQuote(COMPARISON_SCRIPT)} -- ${shellQuote(options.scope)} ${shellQuote(options.base ?? "")}`,
  );
  if (!result.ok) return result;
  if (result.value.exitCode !== 0) {
    let message = failureMessages.comparison_failed;
    try {
      const parsed = ComparisonFailure.safeParse(JSON.parse(result.value.stdout));
      if (parsed.success) message = failureMessages[parsed.data.comparisonError];
    } catch {
      /* Raw Git stderr may contain private repository details. */
    }
    return { ok: false, error: { code: "exec_failed", message } };
  }
  try {
    const parsed = GitComparisonSchema.safeParse(JSON.parse(result.value.stdout));
    if (parsed.success) return { ok: true, value: parsed.data };
  } catch {
    /* Invalid sandbox output is an execution error. */
  }
  return {
    ok: false,
    error: { code: "exec_failed", message: "The repository returned an invalid comparison." },
  };
}
