import { z } from "zod";

/**
 * Reads the Bash permission rules in `.claude/settings.json` the way Claude Code applies them, so
 * a test can show which commands an agent may run without being asked.
 *
 * The allowlist is there so free commands stop prompting, and the money-spending ones must keep
 * prompting however they are spelled. That is easy to get wrong silently: a rule that looks like
 * "one test file" can admit a command that collects the paid integration suite, and nothing
 * notices until a bill does. Kept pure — rules and a command in, a verdict out.
 *
 * Only the parts of the rule syntax this repository uses are modelled: `*` matches any run of
 * characters, `\*` is a literal asterisk, and an `ask` rule overrides an `allow` rule.
 */

export const PermissionsSchema = z.object({
  allow: z.array(z.string()).default([]),
  ask: z.array(z.string()).default([]),
});

export type Permissions = z.infer<typeof PermissionsSchema>;

const BASH_RULE = /^Bash\((.*)\)$/s;

export function ruleMatches(rule: string, command: string): boolean {
  const pattern = BASH_RULE.exec(rule)?.[1];
  if (pattern === undefined) return false;
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] ?? "";
    if (char === "\\" && pattern[i + 1] === "*") {
      source += "\\*";
      i++;
    } else if (char === "*") {
      source += ".*";
    } else {
      source += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`, "s").test(command);
}

export function runsWithoutPrompt(permissions: Permissions, command: string): boolean {
  if (permissions.ask.some((rule) => ruleMatches(rule, command))) return false;
  return permissions.allow.some((rule) => ruleMatches(rule, command));
}
