/**
 * The route box in the workbench's bar: which page of the running app the frame is showing.
 *
 * **It says where the frame is being sent, never where it is.** The preview is another origin,
 * so nothing on this side may ask it what page it is on — a link clicked inside the app changes
 * the frame and this box has no way to hear about it. That is a property of a cross-origin
 * frame, not something to work around; the box is a control, and it is worded as one.
 *
 * Everything an address bar normally does with a whole URL is deliberately refused here. This
 * addresses *the project*: a full URL in this box would point the frame at somebody else's site
 * while the bar around it still said the project's name, and `//host` is the same trick with two
 * characters. Both come out as paths.
 */

/** What was typed, as a path this app will accept. Always starts with exactly one slash. */
export function normaliseRoute(route: string): string {
  const trimmed = route.trim();
  if (trimmed === "") return "/";

  // A scheme means somebody pasted a URL. Keep the part that addresses a page and drop the part
  // that addresses a host — including `javascript:`, which addresses neither.
  const withoutScheme = stripScheme(trimmed);

  // Leading slashes are collapsed rather than trusted: `//example.com` is protocol-relative and
  // would leave this origin entirely.
  const path = withoutScheme.replace(/^\/+/, "");
  return `/${path}`;
}

function stripScheme(value: string): string {
  const scheme = /^[a-z][\w+.-]*:/i.exec(value);
  if (scheme === null) return value;

  // `https://host/path` keeps `/path`; anything else — `javascript:`, `data:` — has no path
  // worth keeping and becomes the root.
  const afterScheme = value.slice(scheme[0].length);
  if (!afterScheme.startsWith("//")) return "";

  const slash = afterScheme.slice(2).indexOf("/");
  return slash === -1 ? "" : afterScheme.slice(2 + slash);
}

/**
 * The address to give the frame: the sandbox's own, with the route on the end.
 *
 * The root gives the base back untouched rather than with a slash stuck on it. The two address
 * the same page, but the frame is keyed on this string — so a cosmetic difference between "the
 * default" and "somebody typed /" would remount the app for no reason a viewer could see.
 */
export function previewUrlFor(base: string, route: string): string {
  const trimmed = base.replace(/\/+$/, "");
  const path = normaliseRoute(route);
  return path === "/" ? trimmed : `${trimmed}${path}`;
}
