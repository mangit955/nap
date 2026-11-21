/**
 * Takes a failed query's parameters out of anything about to be logged.
 *
 * Drizzle wraps every failed query in a `DrizzleQueryError` whose message ends
 * `params: <the values>`, whose stack starts with that message, and which carries the values
 * again in an enumerable `params` field — so pino's `err` serializer, `JSON.stringify` and
 * `console` each write them out. Those values are the data the query was about: a session
 * token on every signed-in request (production wrote one to the log during a database restart,
 * #283), chat text and command output on an event append, an API key's ciphertext. The query
 * text holds only `$1` placeholders and the cause says why it failed, which is all a reader
 * needs, so the parameters are dropped everywhere rather than judged secret or not per table.
 *
 * The database can repeat a value too. A Postgres error's `detail` does for a constraint
 * violation (`Key (email)=(…) already exists`), and so does the message of a data exception
 * (`invalid input syntax for type uuid: "…"`). Both go; the SQLSTATE code and the constraint
 * name still say what happened.
 *
 * Applied where pino is built (`logger.ts`), to `console` at boot (`redactConsole`), and to
 * Better Auth's lines (`auth/better-auth-log.ts`), so no call site has to remember.
 */

const QUERY_MARKER = "Failed query: ";
/** As Drizzle writes it, and as it reads once the message has been JSON-encoded into a string. */
const PARAMS_MARKERS = ["\nparams: ", "\\nparams: "];
const WITHHELD = "\n[query parameters withheld from the log]";

/** Drizzle's field for a query's values, on whatever error carries it. */
const DRIZZLE_FIELDS = new Set<PropertyKey>(["params"]);

/**
 * postgres.js's: `detail` (see above); `where`, the server's error context, which quotes a bind
 * parameter when `log_parameter_max_length_on_error` is set; and the values it attaches
 * non-enumerably — enumerably when its `debug` option is on.
 */
const POSTGRES_FIELDS = new Set<PropertyKey>(["params", "detail", "where", "parameters", "args"]);

/** SQLSTATE class 22, data exceptions: the server's message quotes the value it rejected. */
const ECHOING_CLASS = "22";

/**
 * Deeper than any log line this repo writes. Past it an object is replaced rather than passed
 * through, because passing it through is exactly how a buried query error would get out.
 */
const MAX_DEPTH = 16;

const CIRCULAR = "[Circular]";
const TOO_DEEP = "[nested too deeply to check for query parameters]";
const UNREADABLE = "[withheld: could not be checked for query parameters]";
/** In place of a data exception's message; the code and routine still say what went wrong. */
function echoed(code: string, routine: unknown): string {
  const where = typeof routine === "string" ? ` in ${routine}` : "";
  return `[server message withheld: it can repeat the rejected value] (SQLSTATE ${code}${where})`;
}

/** Marks an object whose copy is still being built, so a reference back to it is a cycle. */
const IN_PROGRESS: unique symbol = Symbol("in progress");

/**
 * The value with every failed query's parameters removed.
 *
 * Errors (with their causes and any nested errors), arrays and plain objects come back as
 * fresh copies, always — never the original, even where nothing needed removing. Keeping an
 * original anywhere is how a cycle or a second reference used to hand pino the unredacted
 * error back. pino writes a copy exactly as it writes the original, which `redact-query-params
 * .test.ts` checks against pino alone. Other class instances are passed through unwalked; this
 * repo logs no error inside one.
 *
 * Never throws: it runs inside every log call, and a log call that throws turns a request's
 * error handler into a second, unlogged error.
 */
export function withoutQueryParams(value: unknown): unknown {
  try {
    return redact(value, 0, new Map());
  } catch {
    return UNREADABLE;
  }
}

/**
 * Routes every `console` method through `withoutQueryParams`.
 *
 * For libraries that write to `console` directly and offer no way not to: Better Auth's adapter
 * and better-call's router both print a raw error with `console.error`, beside the logger they
 * were given. Called once per process, at boot; it changes a global, which is why a component
 * never calls it.
 */
export function redactConsole(target: Console = console): void {
  for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) {
    const original = target[method].bind(target);
    target[method] = (...args: unknown[]) => original(...args.map(withoutQueryParams));
  }
}

/** Each object walked so far, mapped to its copy — or to `IN_PROGRESS` while it is built. */
type Copies = Map<object, unknown>;

function redact(value: unknown, depth: number, copies: Copies): unknown {
  if (typeof value === "string") return redactText(value);
  if (typeof value !== "object" || value === null) return value;
  if (copies.has(value)) {
    const copy = copies.get(value);
    return copy === IN_PROGRESS ? CIRCULAR : copy;
  }
  if (depth > MAX_DEPTH) return TOO_DEEP;

  copies.set(value, IN_PROGRESS);
  const copy = copyOf(value, depth, copies);
  copies.set(value, copy);
  return copy;
}

function copyOf(value: object, depth: number, copies: Copies): unknown {
  if (value instanceof Error) return copyError(value, depth, copies);
  if (Array.isArray(value)) return value.map((item: unknown) => redact(item, depth + 1, copies));
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, field]: [string, unknown]) => [
      key,
      redact(field, depth + 1, copies),
    ]),
  );
}

/**
 * Cuts a Drizzle message at its parameters. They are the last thing in it and may themselves
 * contain newlines, so everything after the marker goes: over-redacting a wrapped message's
 * tail is the safe direction.
 */
function redactText(text: string): string {
  const query = text.indexOf(QUERY_MARKER);
  if (query === -1) return text;
  const found = PARAMS_MARKERS.map((marker) => text.indexOf(marker, query)).filter((i) => i !== -1);
  return found.length === 0 ? text : text.slice(0, Math.min(...found)) + WITHHELD;
}

/**
 * A copy of the error with parameter fields left out and every other field redacted.
 *
 * **Not on the original's prototype.** Some errors keep their fields in getters that check they
 * are called on a real instance: `DOMException` (what `AbortSignal.timeout` rejects with) does
 * for `message`, `name` and `code`, and pino reads every enumerable one. On a look-alike made
 * with `Object.create(proto)` those getters throw, and the log call throws with them. So every
 * field pino would read — own keys, and inherited enumerable ones as `for…in` finds them — is
 * read here, on the original, and becomes the copy's own; the copy's prototype carries only the
 * original constructor, which is where pino takes the error's `type` from.
 *
 * The stack gets the redacted message in place of the original, which keeps the frames, and is
 * then cut like any other text — a wrapper's stack can carry a whole Drizzle stack after its
 * own message.
 */
function copyError(error: Error, depth: number, copies: Copies): Error {
  const isPostgres = readField(error, "name") === "PostgresError";
  const dropped = isPostgres ? POSTGRES_FIELDS : DRIZZLE_FIELDS;
  const code = readField(error, "code");
  const original = readField(error, "message");
  const withheld =
    isPostgres && typeof code === "string" && code.startsWith(ECHOING_CLASS)
      ? echoed(code, readField(error, "routine"))
      : undefined;
  const message = typeof original === "string" ? (withheld ?? redactText(original)) : original;
  const stack = redactStack(readField(error, "stack"), original, message, withheld);

  const copy: Error = Object.create(
    Object.create(Error.prototype, {
      constructor: { value: readField(error, "constructor"), writable: true, configurable: true },
    }),
  );
  copies.set(error, copy);

  const enumerable = new Set<PropertyKey>();
  for (const key in error) enumerable.add(key);
  const keys = new Set<PropertyKey>([...Reflect.ownKeys(error), ...enumerable, "name"]);
  for (const key of keys) {
    if (dropped.has(key)) continue;
    let value: unknown;
    if (key === "message") value = message;
    else if (key === "stack") value = stack;
    else value = redact(readField(error, key), depth + 1, copies);
    Object.defineProperty(copy, key, {
      value,
      enumerable: Object.getOwnPropertyDescriptor(error, key)?.enumerable ?? enumerable.has(key),
      writable: true,
      configurable: true,
    });
  }
  // Read here rather than inherited, whether the original had them as its own or not.
  for (const [key, value] of [
    ["message", message],
    ["stack", stack],
  ] as const) {
    if (!Object.hasOwn(copy, key)) {
      Object.defineProperty(copy, key, { value, writable: true, configurable: true });
    }
  }
  return copy;
}

/**
 * The stack with the redacted message in place of the original, then cut like any other text.
 * A stack that does not repeat a withheld server message — the message was changed after the
 * error was built — may still hold it some other way, so it is replaced outright.
 */
function redactStack(
  stack: unknown,
  original: unknown,
  message: unknown,
  withheld: string | undefined,
): unknown {
  if (typeof stack !== "string") return stack;
  let swapped = stack;
  if (typeof original === "string" && original !== "" && typeof message === "string") {
    // `split`/`join` rather than `replace`: a replacement string treats `$&` as "the match",
    // and SQL text may contain it.
    if (stack.includes(original)) swapped = stack.split(original).join(message);
    else if (withheld !== undefined) swapped = `PostgresError: ${withheld}`;
  }
  return redactText(swapped);
}

/**
 * A field's value, or a placeholder when reading it throws — a getter is somebody else's code.
 * Read through the original rather than copied as a descriptor: V8 makes `stack` an own
 * accessor that answers only for the error it was created on, so a copied getter reads
 * `undefined`.
 */
function readField(error: Error, key: PropertyKey): unknown {
  try {
    return Reflect.get(error, key);
  } catch {
    return UNREADABLE;
  }
}
