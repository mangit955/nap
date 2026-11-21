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
 * A Postgres error's `detail` goes too: for a constraint violation it repeats the rejected
 * value (`Key (email)=(…) already exists`), and its code and constraint name still say what
 * happened.
 *
 * Applied where pino is built (`logger.ts`), to `console` at boot (`redactConsole`), and to
 * Better Auth's lines (`auth/better-auth-log.ts`), so no call site has to remember.
 */

const QUERY_MARKER = "Failed query: ";
const PARAMS_MARKER = "\nparams: ";
const WITHHELD = "\n[query parameters withheld from the log]";

/** Drizzle's field for a query's values, on whatever error carries it. */
const DRIZZLE_FIELDS = new Set<PropertyKey>(["params"]);

/**
 * postgres.js's: `detail` (see above), and the values it attaches non-enumerably — enumerably
 * when its `debug` option is on.
 */
const POSTGRES_FIELDS = new Set<PropertyKey>(["params", "detail", "parameters", "args"]);

/**
 * Deeper than any log line this repo writes. Past it an object is replaced rather than passed
 * through, because passing it through is exactly how a buried query error would get out.
 */
const MAX_DEPTH = 16;

const CIRCULAR = "[Circular]";
const TOO_DEEP = "[nested too deeply to check for query parameters]";
const UNREADABLE = "[withheld: could not be checked for query parameters]";

/**
 * The same value with every failed query's parameters removed, or the very same reference when
 * there were none — so an ordinary line reaches pino exactly as it would have.
 *
 * Strings, errors (with their causes and any nested errors), arrays and plain objects are
 * walked; anything else is a class instance this repo does not log errors inside. Never throws:
 * it runs inside every log call, and a log call that throws turns a request's error handler
 * into a second, unlogged error.
 */
export function withoutQueryParams<T>(value: T): T | string {
  try {
    return redact(value, 0, { done: new Map(), inProgress: new Set() });
  } catch {
    return UNREADABLE;
  }
}

/**
 * Routes every `console` method through `withoutQueryParams`.
 *
 * For libraries that write to `console` directly and offer no way not to: Better Auth's adapter
 * prints the raw error of a failed follow-up read with `console.error(error)`, beside the
 * logger it was given. Called once per process, at boot; it changes a global, which is why a
 * component never calls it.
 */
export function redactConsole(target: Console = console): void {
  for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) {
    const original = target[method].bind(target);
    target[method] = (...args: unknown[]) => original(...args.map(withoutQueryParams));
  }
}

type Walk = {
  /**
   * What each object already became. A second reference to an error must get the redacted
   * copy, not the original — pino and `console` print every reference, not only the first.
   */
  done: Map<object, unknown>;
  /** Objects whose copy is still being built: a reference back to one is a cycle. */
  inProgress: Set<object>;
};

function redact<T>(value: T, depth: number, walk: Walk): T | string {
  if (typeof value === "string") return redactText(value);
  if (typeof value !== "object" || value === null) return value;
  if (walk.done.has(value)) return walk.done.get(value) as T;
  // A back-reference adds nothing to the line, and leaving the original in place would put
  // its unredacted fields back. It does not count as a change on its own: when nothing else in
  // the cycle needed redacting, the original goes out untouched.
  if (walk.inProgress.has(value)) return CIRCULAR;
  if (depth > MAX_DEPTH) return TOO_DEEP;

  walk.inProgress.add(value);
  const result = redactObject(value, depth, walk);
  walk.inProgress.delete(value);
  walk.done.set(value, result);
  return result;
}

function redactObject<T extends object>(value: T, depth: number, walk: Walk): T {
  if (value instanceof Error) return redactError(value, depth, walk) as T;
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item: unknown) => {
      const next = redact(item, depth + 1, walk);
      if (next !== item && next !== CIRCULAR) changed = true;
      return next;
    });
    return (changed ? items : value) as T;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  let changed = false;
  const entries = Object.entries(value).map(([key, field]: [string, unknown]) => {
    const next = redact(field, depth + 1, walk);
    if (next !== field && next !== CIRCULAR) changed = true;
    return [key, next] as const;
  });
  return (changed ? Object.fromEntries(entries) : value) as T;
}

/**
 * Cuts a Drizzle message at its parameters. They are the last thing in it and may themselves
 * contain newlines, so everything after the marker goes: over-redacting a wrapped message's
 * tail is the safe direction.
 */
function redactText(text: string): string {
  const query = text.indexOf(QUERY_MARKER);
  if (query === -1) return text;
  const params = text.indexOf(PARAMS_MARKER, query);
  return params === -1 ? text : text.slice(0, params) + WITHHELD;
}

/**
 * A copy of the error, same prototype so pino still serializes it as an error, with parameter
 * fields left out and every other own field redacted. The stack is rewritten by replacing the
 * message it starts with, which keeps the frames; a stack that does not contain the message is
 * cut like any other text.
 */
function redactError(error: Error, depth: number, walk: Walk): Error {
  const dropped = error.name === "PostgresError" ? POSTGRES_FIELDS : DRIZZLE_FIELDS;
  const original = readField(error, "message");
  const message = typeof original === "string" ? redactText(original) : original;
  let changed = message !== original;
  const fields = new Map<PropertyKey, PropertyDescriptor>();

  for (const key of Reflect.ownKeys(error)) {
    if (dropped.has(key)) {
      changed = true;
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    if (descriptor === undefined) continue;
    // Read through the original, not copied as a descriptor: V8 makes `stack` an own accessor
    // that answers only for the error it was created on, so a copied getter reads `undefined`.
    const before = readField(error, key);
    let next: unknown;
    if (key === "message") next = message;
    else if (key === "stack" && typeof before === "string") {
      // `split`/`join` rather than `replace`: a replacement string treats `$&` as "the match",
      // and SQL text may contain it.
      next =
        typeof original === "string" && before.includes(original)
          ? before.split(original).join(String(message))
          : redactText(before);
    } else next = redact(before, depth + 1, walk);
    if (next !== before && next !== CIRCULAR) changed = true;
    fields.set(key, {
      value: next,
      enumerable: descriptor.enumerable ?? false,
      writable: true,
      configurable: true,
    });
  }

  if (!changed) return error;
  const copy: Error = Object.create(Object.getPrototypeOf(error));
  for (const [key, descriptor] of fields) Object.defineProperty(copy, key, descriptor);
  return copy;
}

/** A field's value, or a placeholder when reading it throws — a getter is somebody else's code. */
function readField(error: Error, key: PropertyKey): unknown {
  try {
    return Reflect.get(error, key);
  } catch {
    return UNREADABLE;
  }
}
