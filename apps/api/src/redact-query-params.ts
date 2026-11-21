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
 * Applied once, where pino is built (`logger.ts`), so every process and every call site is
 * covered without each having to remember; and again on Better Auth's lines, which would
 * otherwise go to `console` (`auth/auth.ts`).
 */

const QUERY_MARKER = "Failed query: ";
const PARAMS_MARKER = "\nparams: ";
const WITHHELD = "\n[query parameters withheld from the log]";

/** Own fields of an error that hold a query's values: Drizzle's, and postgres.js's in debug mode. */
const PARAMETER_FIELDS = new Set<PropertyKey>(["params", "parameters"]);

/** Deeper than any log line this repo writes; past it a value is passed through untouched. */
const MAX_DEPTH = 8;

/**
 * The same value with every failed query's parameters removed, or the very same reference when
 * there were none — so an ordinary error reaches pino exactly as it would have.
 *
 * Strings, errors (with their causes and any nested errors), arrays and plain objects are
 * walked; anything else is a class instance this repo does not log errors inside.
 */
export function withoutQueryParams<T>(value: T): T {
  return redact(value, 0, new WeakSet());
}

function redact<T>(value: T, depth: number, seen: WeakSet<object>): T {
  if (typeof value === "string") return redactText(value) as T;
  if (typeof value !== "object" || value === null || depth > MAX_DEPTH || seen.has(value)) {
    return value;
  }
  seen.add(value);
  if (value instanceof Error) return redactError(value, depth, seen) as T;
  if (Array.isArray(value)) {
    const items = value.map((item: unknown) => redact(item, depth + 1, seen));
    return (items.every((item, i) => item === value[i]) ? value : items) as T;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  let changed = false;
  const entries = Object.entries(value).map(([key, field]: [string, unknown]) => {
    const next = redact(field, depth + 1, seen);
    if (next !== field) changed = true;
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
function redactError(error: Error, depth: number, seen: WeakSet<object>): Error {
  const message = redactText(error.message);
  let changed = message !== error.message;
  const fields = new Map<PropertyKey, PropertyDescriptor>();

  for (const key of Reflect.ownKeys(error)) {
    if (PARAMETER_FIELDS.has(key)) {
      changed = true;
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    if (descriptor === undefined) continue;
    // Read through the original, not copied as a descriptor: V8 makes `stack` an own accessor
    // that answers only for the error it was created on, so a copied getter reads `undefined`.
    const original: unknown = Reflect.get(error, key);
    let next: unknown;
    if (key === "message") next = message;
    else if (key === "stack" && typeof original === "string") {
      next = original.includes(error.message)
        ? original.replace(error.message, message)
        : redactText(original);
    } else next = redact(original, depth + 1, seen);
    if (next !== original) changed = true;
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
