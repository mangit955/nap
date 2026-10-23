import { type GitComparison, GitComparisonSchema, type GitScope } from "@nap/shared/git-protocol";
import type { SandboxError, SandboxManager } from "@nap/shared/ports/sandbox-manager";
import type { Result } from "@nap/shared/result";
import { shellQuote } from "@nap/shared/shell";
import { TEMPLATE_WORKDIR } from "./template.ts";

// Executed inside the sandbox. Argument arrays keep paths and refs out of the shell.
export const COMPARISON_SCRIPT = String.raw`
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const [scope, requestedBase] = process.argv.slice(1);
const git = (...args) => execFileSync('git', ['-c', 'core.quotePath=false', '--no-pager', ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
const head = git('rev-parse', 'HEAD').trim();
let base = head;
let baseLabel = 'HEAD';
if (scope === 'branch') {
  if (requestedBase) {
    const resolved = git('rev-parse', '--verify', '--end-of-options', requestedBase + '^{commit}').trim();
    base = git('merge-base', resolved, head).trim();
    baseLabel = requestedBase;
  } else {
    base = git('rev-list', '--max-parents=0', 'HEAD').trim().split('\n')[0];
    baseLabel = 'Initial commit';
  }
} else if (scope === 'commit') {
  try { base = git('rev-parse', 'HEAD^').trim(); }
  catch { base = git('hash-object', '-t', 'tree', '--stdin').trim(); }
  baseLabel = 'HEAD^';
}
const target = scope === 'commit' ? [head] : [];
const fields = git('diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', '-M', base, ...target, '--').split('\0');
const entries = [];
while (fields.length > 1) {
  const status = fields.shift();
  const path = fields.shift();
  if (!status || !path) break;
  if (status[0] === 'R' || status[0] === 'C') entries.push({ status: status[0] === 'R' ? 'renamed' : 'copied', previousPath: path, path: fields.shift() });
  else entries.push({ status: ({ A: 'added', D: 'deleted', T: 'typechanged' })[status[0]] || 'modified', previousPath: null, path });
}
if (scope !== 'commit') for (const path of git('ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean)) entries.push({ status: 'untracked', previousPath: null, path });
const hash = createHash('sha256').update(head).update(base);
let remaining = 384 * 1024;
const files = entries.slice(0, 300).map(entry => {
  let patch = '';
  let overflow = false;
  try {
    patch = entry.status === 'untracked'
      ? git('diff', '--no-ext-diff', '--no-textconv', '--no-index', '--', '/dev/null', entry.path)
      : git('diff', '--no-ext-diff', '--no-textconv', '--no-color', '-M', '--unified=3', base, ...target, '--', ...(entry.previousPath ? [entry.previousPath] : []), entry.path);
  } catch (error) {
    if (entry.status === 'untracked' && error.status === 1) patch = String(error.stdout);
    else if (error.code === 'ENOBUFS') { patch = String(error.stdout || ''); overflow = true; }
    else throw error;
  }
  hash.update(entry.path).update(patch);
  const binary = /^Binary files /m.test(patch);
  let additions = 0, deletions = 0, hunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) hunk = true;
    else if (hunk && line.startsWith('+')) additions++;
    else if (hunk && line.startsWith('-')) deletions++;
  }
  const limit = Math.max(0, Math.min(120 * 1024, remaining));
  const truncated = overflow || Buffer.byteLength(patch) > limit;
  if (truncated) {
    patch = Buffer.from(patch).subarray(0, limit).toString('utf8');
    patch = patch.slice(0, Math.max(0, patch.lastIndexOf('\n')));
  }
  remaining -= Buffer.byteLength(patch);
  return { ...entry, additions, deletions, binary, truncated, patch };
});
if (git('rev-parse', 'HEAD').trim() !== head) throw new Error('The repository changed while reading. Refresh to compare the new revision.');
let branch = '';
try { branch = git('symbolic-ref', '--short', 'HEAD').trim(); } catch { branch = head.slice(0, 8); }
process.stdout.write(JSON.stringify({ ready: true, scope, base, head, baseLabel, branch, revision: hash.digest('hex'), capturedAt: new Date().toISOString(), truncated: entries.length > files.length || files.some(file => file.truncated), files }));
`;

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
  if (result.value.exitCode !== 0)
    return {
      ok: false,
      error: {
        code: "exec_failed",
        message: "Could not compare the repository. Check the base branch and refresh.",
      },
    };
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
