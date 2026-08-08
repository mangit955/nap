/**
 * Rendering untrusted text as shell arguments.
 *
 * This lives in the base package because two unrelated callers need the same guarantee:
 * git commits a message a model wrote, and a search tool passes a pattern a model wrote to
 * `grep`. Both interpolate that text into a command line that is about to run inside a
 * user's sandbox. Two copies of this function would be two chances to get it wrong.
 */

/**
 * Renders a string as a single literal shell argument.
 *
 * The text arrives containing whatever a model felt like emitting — quotes, backticks,
 * `$(…)`, newlines. Interpolated raw, that is command injection, and the attacker is
 * whatever the user typed into a chat box.
 *
 * Single quotes suppress every form of shell expansion; the only character that needs
 * handling is a single quote itself, which cannot appear inside them. The POSIX-portable
 * escape is to close the string, emit a backslash-escaped quote, and reopen it.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
