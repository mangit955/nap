/**
 * The description of the draft pull request a verified job opens, with what its reviewer noted.
 *
 * The notes come from the session's log rather than the job row: the publisher already folds the
 * log to find the verified commit, the log is append-only so a retried publish writes the same
 * description, and reading it costs no model call (docs/adr/0036, Consequences).
 *
 * They are model output posted to GitHub, where the repository's collaborators, or everyone, will
 * read them. So they are shown verbatim inside a code fence, where nothing renders as markdown or
 * HTML and an `@name` notifies nobody; secrets a reviewer's command printed are redacted on a best
 * effort; and the whole description is kept inside GitHub's limit.
 */

import type { NapEvent } from "@nap/shared/events";
import { REVIEW_CHECK_NAME } from "@nap/shared/ports/reviewer";

/** The longest pull request description GitHub accepts, in characters. */
export const PULL_REQUEST_BODY_LIMIT = 65_536;

export type PullRequestBodyOptions = {
  jobId: string;
  verifiedSha: string;
  /** The session's log, which holds the job's checks. */
  events: readonly NapEvent[];
};

export function pullRequestBody({ jobId, verifiedSha, events }: PullRequestBodyOptions): string {
  const head = `Changes prepared and checked in Nap.\n\nJob: ${jobId}\nVerified commit: ${verifiedSha}`;
  const tail = "Review this draft before merging.";
  const notes = reviewNotes(events, jobId);
  if (notes === null) return `${head}\n\n${tail}`;

  const render = (shown: string, cut: number) =>
    [
      head,
      "### Reviewer's notes",
      "A second model reviewed this change after its checks passed. These notes did not block publishing: only a problem it proves by running a command sends the work back.",
      fenced(shown),
      ...(cut === 0
        ? []
        : [`${cut} characters of the notes are not shown: GitHub limits a description's length.`]),
      tail,
    ].join("\n\n");

  const redacted = redactSecrets(notes);
  let shown = redacted;
  let text = render(shown, 0);
  // Two passes as a rule: the first cut makes the notes fit, and the line saying how much was cut
  // then needs room of its own. Each pass removes at least one character, so it ends.
  while (text.length > PULL_REQUEST_BODY_LIMIT) {
    shown = withoutLoneSurrogate(
      shown.slice(0, shown.length - (text.length - PULL_REQUEST_BODY_LIMIT)),
    );
    text = render(shown, characters(redacted) - characters(shown));
  }
  return text;
}

/**
 * What the review of the published commit noted, or `null` when it noted nothing.
 *
 * Read from the job's last `verification.completed`, the one that verified the commit being
 * published. When the job ran out of review rounds that event has no review, and an earlier
 * round's findings are about a commit a repair has since changed, so nothing is shown.
 */
function reviewNotes(events: readonly NapEvent[], jobId: string): string | null {
  const last = events.findLast(
    (event) => event.type === "verification.completed" && event.payload.jobId === jobId,
  );
  if (last?.type !== "verification.completed") return null;
  const review = last.payload.checks.find((check) => check.name === REVIEW_CHECK_NAME);
  if (review?.outcome !== "passed" || review.output === null) return null;
  return review.output.trim() === "" ? null : review.output;
}

/** A code fence one backtick longer than any run inside, so no line of the text can close it. */
function fenced(text: string): string {
  // A loop, not `Math.max(...runs)`: spreading one argument per run overflows the stack.
  let longest = 0;
  for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
}

/** Characters as a reader counts them: an emoji is one, where `length` counts it as two. */
function characters(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

function withoutLoneSurrogate(text: string): string {
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}

const REDACTED = "<redacted>";

/**
 * Every token pattern below starts after a character that cannot continue the token, rather than at a
 * `\b`, so a long run of near-misses is scanned once instead of once from every point in it: with
 * `\b`, 64 KiB of `eyJ-` or `a.` took seconds of the worker's event loop. A line's leading `+` or
 * `-` also counts as a start, because that is how a token in a file looks in `git log -p`.
 */
const START = "(?:(?<=^[+-])|(?<![A-Za-z0-9_.+-]))";

/** Shapes of credentials that are unambiguous on their own, wherever they appear. */
const TOKEN_SHAPES: readonly RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  // Stripe.
  /[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/,
  /(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/,
  /AIza[0-9A-Za-z_-]{35}/,
  /SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/,
  /glpat-[A-Za-z0-9_-]{20,}/,
  /npm_[A-Za-z0-9]{36}/,
  /hf_[A-Za-z0-9]{30,}/,
  /xox[abposr]-[A-Za-z0-9-]{10,}/,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
].map((shape) => new RegExp(`${START}(?:${shape.source})`, "gm"));

/**
 * OpenAI, OpenRouter (`sk-or-`) and Anthropic (`sk-ant-`) keys. Apart from the others because
 * `sk-` also starts hyphenated words, `sk-learn-compatible`, and only a key carries a digit.
 */
const SK_KEY = new RegExp(`${START}sk-[A-Za-z0-9_-]{16,}`, "gm");

/**
 * The text with credentials replaced, as far as their shape or their name gives them away.
 *
 * Best effort, not a guarantee: a reviewer may run `cat .env` or `git log -p` in a repository whose
 * history holds a key, and the recorded Terminal-Bench reviews did quote planted credentials. A
 * secret with no recognisable shape and no telling name beside it gets through.
 */
export function redactSecrets(text: string): string {
  // A key cut off before its END line, by the reviewer or by its own output limit, goes to the end.
  let out = text.replace(
    // PGP's armour says `PRIVATE KEY BLOCK`; PEM's says `PRIVATE KEY`.
    /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|[\s\S]*$)/g,
    "<redacted private key>",
  );
  // `postgres://user:password@host`, `redis://:password@host`, `https://token@github.com`.
  out = out.replace(
    new RegExp(`${START}([A-Za-z][A-Za-z0-9+.-]*:\\/\\/)[^\\s/@]+@`, "gm"),
    `$1${REDACTED}@`,
  );
  out = out.replace(
    new RegExp(`${START}(Bearer)[ \\t]+[A-Za-z0-9._~+/=-]{16,}`, "gim"),
    `$1 ${REDACTED}`,
  );
  out = out.replace(/(Authorization:[ \t]*Basic)[ \t]+[A-Za-z0-9+/=]{8,}/gi, `$1 ${REDACTED}`);
  for (const shape of TOKEN_SHAPES) out = out.replace(shape, REDACTED);
  out = out.replace(SK_KEY, (match) => (/\d/.test(match) ? REDACTED : match));
  return redactAssigned(out);
}

/**
 * A name that says its value is a credential: it ends in one of these words, optionally followed
 * by `_id` or `_base` (`AWS_ACCESS_KEY_ID`, `SECRET_KEY_BASE`).
 */
const SECRET_NAME =
  /(?:secret|passwd|password|[_.-]pwd|(?:^|[_.-])pass(?:phrase)?|token|(?:^|[_.-]|api|access|private|secret)key)(?:[_-]?(?:id|base))?$/i;

/**
 * Values that name where a secret comes from rather than being one: code quoted in a note. Each is
 * closed at the end, so a skipped value never holds another `name=` to be scanned again (an open
 * `^\$` made `token=$` repeated quadratic) and a password that merely starts with `$` or holds a
 * dot is not mistaken for code.
 */
const NOT_A_VALUE = [
  /^(?:None|null|nil|undefined|true|false|string|str|number|int|bool|boolean)$/i,
  /^\$\{?[A-Za-z_]\w*\}?$/,
  /^[a-z_]\w*(?:\.[A-Za-z_]\w*)+$/,
  /^(?:process\.env|os\.environ)[\w.[\]]*$/,
];

/**
 * `NAME=value`, `name: "value"` and `?api_key=value` where the name says what the value is.
 *
 * Each name is matched whole, from the start of its run, and judged afterwards, and the scan goes
 * on right after a name that is not secret, so `https://host/?api_key=…` is still reached. After a
 * colon and a space a value is redacted only when it ends its line, as in YAML or a header (a
 * trailing `# comment`, comma or closing bracket still counts), so a note that says "password: OAuth2 flow is not wired"
 * reads as written. `==` is a comparison, and a value followed by `(` is a call. Go's `:=` and
 * PHP's `=>` are whole operators: matched as `:` or `=` alone, their second character was taken for
 * the value and the secret after it was left showing.
 *
 * A `${…}` value is bounded, so a `${` that is never closed is not scanned to the end of the text
 * from every `name=` before it.
 */
function redactAssigned(text: string): string {
  const assignment = /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]+)(["']?[ \t]*(?::=|=>|=(?!=)|:)[ \t]*)/g;
  const value = /"[^"\n]*"|'[^'\n]*'|\$\{[^}\s]{0,256}\}|[^\s"'`&;,()[\]{}]+/y;
  let out = "";
  let from = 0;
  for (let match = assignment.exec(text); match !== null; match = assignment.exec(text)) {
    const [whole, name = "", separator = ""] = match;
    if (!SECRET_NAME.test(name)) continue;
    value.lastIndex = match.index + whole.length;
    const found = value.exec(text)?.[0];
    if (found === undefined) continue;
    const called = text[value.lastIndex] === "(";
    // A bare callee is code, and so is every `name=` inside it, since each ends at the same `(`: go
    // on after it rather than reading it again from each of them. The arguments are still scanned,
    // and so is a quoted string or `${…}`, which is closed and so cannot be read again from far away.
    if (called) {
      if (!/^(?:["']|\$\{)/.test(found)) assignment.lastIndex = value.lastIndex;
      continue;
    }
    const secret = looksSecret({
      value: found,
      name,
      separator,
      endsLine: onlyLineEndFollows(text, value.lastIndex),
    });
    if (!secret) continue;
    out += `${text.slice(from, value.lastIndex - found.length)}${REDACTED}`;
    from = value.lastIndex;
    assignment.lastIndex = value.lastIndex;
  }
  return out + text.slice(from);
}

/**
 * Whether nothing but blanks, closing punctuation and a `# comment` stands between `at` and the
 * end of its line. A comment's `#` has a blank on each side, or ends the line, as in YAML and a
 * shell. A loop, not a regex: the regex this replaced had three blank runs that could share out
 * the same blanks, and one long run of spaces after `token: a` took seconds to reject.
 */
function onlyLineEndFollows(text: string, at: number): boolean {
  const blank = (i: number) => text[i] === " " || text[i] === "\t";
  const atLineEnd = (i: number) => i === text.length || text[i] === "\n" || text[i] === "\r";
  let i = at;
  while (blank(i)) i++;
  while (i < text.length && ",;)]}".includes(text.charAt(i))) i++;
  while (blank(i)) i++;
  if (text[i] === "#" && blank(i - 1)) {
    i++;
    // The comment runs to the line's end, so there is nothing left to check. Walking to it instead
    // read the rest of the line again for every `name: value # ` on it.
    if (blank(i)) return true;
  }
  return atLineEnd(i);
}

function looksSecret(candidate: {
  value: string;
  name: string;
  separator: string;
  endsLine: boolean;
}): boolean {
  const { value, name, separator, endsLine } = candidate;
  if (NOT_A_VALUE.some((pattern) => pattern.test(value))) return false;
  if (/^(["']).*\1$/.test(value)) return value.length > 2;
  // `=`, or a colon with nothing after it: an assignment, not a sentence.
  if (!/:[ \t]/.test(separator)) return true;
  // "session token: 123456" counts something; "ROOT_PASSWORD: 123456" in a compose file is one.
  return endsLine && !(/token$/i.test(name) && /^\d+$/.test(value));
}
