import { randomUUID } from "node:crypto";
import type { NapEvent, VerifiedCheck } from "@nap/shared/events";
import { describe, expect, it } from "vitest";
import { PULL_REQUEST_BODY_LIMIT, pullRequestBody, redactSecrets } from "./pull-request-body.ts";

const JOB = randomUUID();
const SESSION = randomUUID();
const SHA = "b".repeat(40);
const TODAY = `Changes prepared and checked in Nap.\n\nJob: ${JOB}\nVerified commit: ${SHA}\n\nReview this draft before merging.`;

let seq = 0;
function completed(checks: VerifiedCheck[], jobId = JOB): NapEvent {
  seq += 1;
  return {
    sessionId: SESSION,
    turnId: randomUUID(),
    seq,
    createdAt: new Date().toISOString(),
    type: "verification.completed",
    payload: { jobId, checks },
  };
}
const review = (outcome: VerifiedCheck["outcome"], output: string | null): VerifiedCheck => ({
  name: "review",
  outcome,
  output,
});
const passedTests: VerifiedCheck = { name: "test", outcome: "passed", output: null };
const body = (events: NapEvent[]) => pullRequestBody({ jobId: JOB, verifiedSha: SHA, events });

describe("pullRequestBody", () => {
  it("is today's fixed text when the job has no review, or a review with no notes", () => {
    expect(body([])).toBe(TODAY);
    expect(body([completed([passedTests])])).toBe(TODAY);
    expect(body([completed([passedTests, review("passed", null)])])).toBe(TODAY);
    expect(body([completed([passedTests, review("passed", "  \n ")])])).toBe(TODAY);
  });

  it("shows the notes of the review that passed the published commit, in a code block", () => {
    const notes = "- Git is not installed, so the push was not tried.";
    const text = body([completed([passedTests, review("passed", notes)])]);
    expect(text).toContain(`\`\`\`text\n${notes}\n\`\`\``);
    expect(text.startsWith(TODAY.replace("\n\nReview this draft before merging.", ""))).toBe(true);
    expect(text.endsWith("Review this draft before merging.")).toBe(true);
  });

  it("reads only the job's last verification, so an earlier round's review is not shown", () => {
    // Round one blocked and was repaired; with its rounds spent the repair was not reviewed again,
    // so what the first review said is about a commit that is not the one being published.
    const earlier = completed([passedTests, review("failed", "- The parser drops errors.")]);
    expect(body([earlier, completed([passedTests])])).toBe(TODAY);
    const repaired = completed([passedTests, review("passed", "- Now raises on bad input.")]);
    expect(body([earlier, repaired])).toContain("- Now raises on bad input.");
    expect(body([earlier, repaired])).not.toContain("drops errors");
  });

  it("ignores another job's review", () => {
    const other = completed([review("passed", "- Someone else's note.")], randomUUID());
    expect(body([completed([passedTests]), other])).toBe(TODAY);
  });

  it("fences notes so markdown, HTML and @mentions in them render as plain text", () => {
    const hostile = "- ping @octocat\n```\n<img src=x onerror=alert(1)>\n````\n[x](https://evil)";
    const text = body([completed([review("passed", hostile)])]);
    // Five backticks: one longer than the longest run inside, so no line of the notes closes it.
    expect(text).toContain(`\`\`\`\`\`text\n${hostile}\n\`\`\`\`\``);
  });

  it("fences notes with millions of backtick runs without overflowing the stack", () => {
    // Spreading every run's length into `Math.max` threw a RangeError at about 200,000 runs.
    const text = body([completed([review("passed", "` ".repeat(2_000_000))])]);
    expect(text.length).toBeLessThanOrEqual(PULL_REQUEST_BODY_LIMIT);
  });

  it("redacts secrets the reviewer's commands printed", () => {
    const leaked =
      "- Still in history:\n  `git log -p` printed:\n    token ghp_0123456789abcdefghijABCDEFGHIJ012345";
    const text = body([completed([review("passed", leaked)])]);
    expect(text).not.toContain("ghp_0123456789");
    expect(text).toContain("token <redacted>");
  });

  it("fills GitHub's body limit, and says exactly how much of the notes it cut", () => {
    const huge = `- ${"x".repeat(PULL_REQUEST_BODY_LIMIT * 2)}`;
    const text = body([completed([review("passed", huge)])]);
    expect(text.length).toBeLessThanOrEqual(PULL_REQUEST_BODY_LIMIT);
    expect(text.length).toBeGreaterThan(PULL_REQUEST_BODY_LIMIT - 4);
    const shown = shownNotes(text);
    expect(huge.startsWith(shown)).toBe(true);
    expect(text).toContain(
      `${huge.length - shown.length} characters of the notes are not shown: GitHub limits a description's length.`,
    );
    expect(text.endsWith("Review this draft before merging.")).toBe(true);
  });

  it("cuts between characters, never inside one, and counts an emoji as one", () => {
    // An odd offset puts the cut inside the two halves of an emoji unless it is stepped back.
    for (const lead of ["", "-"]) {
      const notes = `${lead}${"🙂".repeat(PULL_REQUEST_BODY_LIMIT)}`;
      const text = body([completed([review("passed", notes)])]);
      expect(text.length).toBeLessThanOrEqual(PULL_REQUEST_BODY_LIMIT);
      const shown = shownNotes(text);
      expect(shown).toMatch(/^-?(?:🙂)+$/u);
      const cut = [...notes].length - [...shown].length;
      expect(text).toContain(`${cut} characters of the notes are not shown`);
    }
  });

  it("shows nothing for a review that failed, even in the last verification", () => {
    expect(body([completed([review("failed", "- It is broken.")])])).toBe(TODAY);
  });
});

/** The notes as the body shows them, from inside their fence. */
function shownNotes(text: string): string {
  const match = /\n(`{3,})text\n([\s\S]*)\n\1\n/.exec(text);
  if (match === null) throw new Error("no fenced notes");
  return match[2] ?? "";
}

/**
 * A fake credential put together at run time. Whole in the source, GitHub's push protection reads
 * it as a leaked secret and refuses the push, and GitGuardian's check on the pull request fails.
 */
function fake(...parts: string[]): string {
  return parts.join("");
}

describe("redactSecrets", () => {
  it.each([
    ["GitHub token", "ghs_0123456789abcdefghijABCDEFGHIJ012345"],
    ["fine-grained GitHub token", "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz"],
    ["OpenRouter key", "sk-or-v1-0123456789abcdef0123456789abcdef"],
    ["Anthropic key", "sk-ant-api03-0123456789abcdefghij"],
    ["AWS access key id", "AKIAIOSFODNN7EXAMPLE"],
    // Letters only, as real ones are.
    ["Hugging Face token", fake("hf_", "abcdefghijklmnopqrstuvwxyzABCDEFGH")],
    ["Slack token", "xoxb-1234567890-abcdefghij"],
    ["JWT", fake("eyJhbGciOiJIUzI1NiJ9.", "eyJzdWIiOiIxIn0.", "c2lnbmF0dXJlLXZhbHVl")],
    ["Stripe key", fake("sk_", "live_", "abcdefghijklmnop12345678")],
    ["Google API key", "AIzaSyA-0123456789abcdefghijklmnopqrstu"],
    ["GitLab token", "glpat-abcdefghijKLMNOPQRSTu"],
    ["npm token", "npm_0123456789abcdefghijABCDEFGHIJ012345"],
  ])("removes a %s", (_, secret) => {
    expect(redactSecrets(`value: ${secret} end`)).toBe("value: <redacted> end");
  });

  it("keeps the name of an assigned secret and removes its value", () => {
    expect(redactSecrets(fake("export AWS_SECRET_ACCESS_KEY=", "wJalrXUtnFEMI/K7MDENG"))).toBe(
      "export AWS_SECRET_ACCESS_KEY=<redacted>",
    );
    expect(redactSecrets('DB_PASSWORD: "hunter2"')).toBe("DB_PASSWORD: <redacted>");
    expect(redactSecrets("Authorization: Bearer abc.def-ghi_jkl012345678")).toBe(
      "Authorization: Bearer <redacted>",
    );
  });

  it.each([
    ["DATABASE_URL=postgres://user:pa55word@host/db", "DATABASE_URL=postgres://<redacted>@host/db"],
    ["redis://:hunter2@cache:6379", "redis://<redacted>@cache:6379"],
    [
      "mongodb+srv://admin:hunter2@cluster0.example.net",
      "mongodb+srv://<redacted>@cluster0.example.net",
    ],
    [
      "curl https://api.example.com/v1?api_key=abcd1234&x=1",
      "curl https://api.example.com/v1?api_key=<redacted>&x=1",
    ],
    ["Server=db;User Id=sa;Password=hunter2;", "Server=db;User Id=sa;Password=<redacted>;"],
    ["user:bob,password:hunter2", "user:bob,password:<redacted>"],
    ['{"api_key": "abc123"}', '{"api_key": <redacted>}'],
    ["AWS_ACCESS_KEY_ID=AKIA", "AWS_ACCESS_KEY_ID=<redacted>"],
    ["SECRET_KEY=django-insecure-4x9q!a", "SECRET_KEY=<redacted>"],
    ["SECRET_KEY = 'django-insecure-4x9q!a'", "SECRET_KEY = <redacted>"],
    ["JWT_SECRET_KEY=abcdef123456", "JWT_SECRET_KEY=<redacted>"],
    [fake("AWS_SECRET_KEY=", "wJalrXUtnFEMIK7MDENG"), "AWS_SECRET_KEY=<redacted>"],
    ["DB_PASS=hunter2", "DB_PASS=<redacted>"],
    ["SMTP_PASS=hunter2", "SMTP_PASS=<redacted>"],
    ["APP_KEY=base64:abcdefgh", "APP_KEY=<redacted>"],
    ["ENCRYPTION_KEY=abcdefgh", "ENCRYPTION_KEY=<redacted>"],
    ["MYSQL_ROOT_PASSWORD=123456", "MYSQL_ROOT_PASSWORD=<redacted>"],
    ["DB_PASSWORD: supersecretpassword", "DB_PASSWORD: <redacted>"],
    ["X-Api-Key: abc123\nnext", "X-Api-Key: <redacted>\nnext"],
    [fake("authorization: bearer ", "abcdefghijklmnop1234"), "authorization: bearer <redacted>"],
    ["+ghp_0123456789abcdefghijABCDEFGHIJ012345", "+<redacted>"],
    ["-sk-or-v1-0123456789abcdef0123456789abcdef", "-<redacted>"],
    ["context\n-PASSWORD=hunter2", "context\n-PASSWORD=<redacted>"],
    [
      "diff --git a/.env b/.env\n+ghp_0123456789abcdefghijABCDEFGHIJ012345",
      "diff --git a/.env b/.env\n+<redacted>",
    ],
    ["X-Api-Key: abc123\r\nnext", "X-Api-Key: <redacted>\r\nnext"],
    ["DB_PASSWORD: hunter2\r", "DB_PASSWORD: <redacted>\r"],
    ["  password: s3cr3t # change me\n", "  password: <redacted> # change me\n"],
    ["MYSQL_ROOT_PASSWORD: 123456", "MYSQL_ROOT_PASSWORD: <redacted>"],
    [
      `SENDGRID_API_KEY=${fake("SG.", "abcdefghijklmnopqrstuv.", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ")}`,
      "SENDGRID_API_KEY=<redacted>",
    ],
    [fake("DB_PASSWORD=", "hunter2.0"), "DB_PASSWORD=<redacted>"],
    [fake("PASSWORD=", "Passw0rd.2024"), "PASSWORD=<redacted>"],
    [fake("DB_PASSWORD=", "$uperSecret!"), "DB_PASSWORD=<redacted>"],
    ["HASHED_PASSWORD=$2b$12$abcdefghijklmnop", "HASHED_PASSWORD=<redacted>"],
    ["{ password: hunter2 }", "{ password: <redacted> }"],
    ["  token: abc123def,\n", "  token: <redacted>,\n"],
    // A shell default, not a template placeholder: the default is a credential.
    [
      fake("POSTGRES_PASSWORD=", `\${POSTGRES_PASSWORD:-`, "postgres", "}"),
      "POSTGRES_PASSWORD=<redacted>",
    ],
    // Go and PHP: the operator was once taken for the value, leaving the secret beside the marker.
    ['password := "hunter2"', "password := <redacted>"],
    ["'password' => 'hunter2'", "'password' => <redacted>"],
  ])("redacts the credential in %s", (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it("removes credentials in a URL and a private key block, even one cut short", () => {
    expect(redactSecrets("git clone https://user:pa55@github.com/o/r.git")).toBe(
      "git clone https://<redacted>@github.com/o/r.git",
    );
    expect(redactSecrets("a\n-----BEGIN PRIVATE KEY-----\nMIIE\nabc")).toBe(
      "a\n<redacted private key>",
    );
    expect(
      redactSecrets(
        "a\n-----BEGIN RSA PRIVATE KEY-----\nMIIE\nabc\n-----END RSA PRIVATE KEY-----\nb",
      ),
    ).toBe("a\n<redacted private key>\nb");
    expect(
      redactSecrets(
        "a\n-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF\n-----END PGP PRIVATE KEY BLOCK-----\nb",
      ),
    ).toBe("a\n<redacted private key>\nb");
  });

  it("takes linear time on output built to make a pattern backtrack", () => {
    // Quadratic before: 64 KiB of `a.` took about five seconds, all of it on the event loop.
    const started = performance.now();
    // At eight times the longest description, where a quadratic pattern takes seconds.
    for (const unit of [
      "a.",
      "token",
      "token-",
      "a=",
      "secret ",
      "password=",
      "eyJ-",
      "sk-",
      "x://",
      "Bearer ",
      "-----BEGIN PRIVATE KEY-----",
      "token=$",
      "token=process.env",
      "pass=$",
      "$password=",
      "PASSWORD=${",
      "token=${a",
    ])
      redactSecrets(unit.repeat(Math.ceil((8 * PULL_REQUEST_BODY_LIMIT) / unit.length)));
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("takes linear time when the last character decides every value before it", () => {
    // Each was quadratic or worse before: one long value or line judged again from every name in
    // it. Blanks after `token: a` took 11 s on one description; the others took seconds at 8x.
    const long = (unit: string) =>
      unit.repeat(Math.ceil((8 * PULL_REQUEST_BODY_LIMIT) / unit.length));
    const started = performance.now();
    redactSecrets(`token: a${" ".repeat(PULL_REQUEST_BODY_LIMIT)}x`);
    redactSecrets(`password: hunter2${"\t".repeat(PULL_REQUEST_BODY_LIMIT)}#x`);
    redactSecrets(long("token: a # "));
    redactSecrets(`${long("token=")}x(`);
    redactSecrets(`${long("token:")}(`);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("still finds a credential passed into a call", () => {
    expect(redactSecrets("token=getToken(api_key=abc123)")).toBe(
      "token=getToken(api_key=<redacted>)",
    );
    // A quoted or `${…}` value before `(` is not a callee to skip: what is inside it is still read.
    expect(redactSecrets('token="api_key=abc123"(x)')).toBe('token="api_key=<redacted>"(x)');
    expect(redactSecrets(`token=\${api_key=abc123}(x)`)).toBe(`token=\${api_key=<redacted>}(x)`);
  });

  it.each([
    ["password: hunter2   # change me", "password: <redacted>   # change me"],
    ["password: hunter2\t#", "password: <redacted>\t#"],
    ["token: abc123 ,  \nnext", "token: <redacted> ,  \nnext"],
    ["token: abc123 #x", "token: abc123 #x"],
    ["token: abc123,# x", "token: abc123,# x"],
  ])("judges the end of the line after %j", (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it.each([
    "- `pytest -rA` passed all 367 tests, but the token count is wrong.\n  `curl http://localhost:8080/simple` printed:\n    200 OK",
    "- password: the new form never hashes it",
    "- `password: string` is stored in plaintext",
    "- Password: must be at least 8 characters",
    "- api_key: missing from the docs",
    "- src/auth/token.ts:42: the check is inverted",
    "- Token: expiry is never checked",
    "- tokenizer: drops trailing whitespace",
    "- max_tokens: undefined",
    "- session_token_ttl: 30m",
    "- Basic validation/sanitization is missing",
    "- the token refresh/rotation-logic never runs",
    "- uses sk-learn-compatible-estimators-everywhere",
    "- Input tokens: 7481",
    "- secret_key: never rotated",
    "- secret: SHA256 hash is unsalted",
    "- Token: ES256-signed, but never verified",
    "- password: OAuth2 flow is not wired",
    "- access_token: expires_in=3600 is ignored",
    "- `if (token === undefined)` never runs",
    "- `if token == expected:` compares the wrong value",
    "- `user.password == input` is not constant-time",
    "- `const password = req.body.password` is logged",
    "- `connect(password=None)` skips auth",
    // A shell reference, not a template placeholder.
    `- PASSWORD=\${DB_PASSWORD} is read at boot`,
    "- the session token: 123456",
    'password=""',
    '{"token": null}',
    "  token: string\n",
    "- `token = get_token()` is never awaited",
    "- `os.environ['SECRET_KEY']` is read twice",
    "- `process.env.TOKEN` is undefined in tests",
    "PWD=/app",
  ])("leaves review prose alone: %s", (prose) => {
    expect(redactSecrets(prose)).toBe(prose);
  });
});
