/**
 * What every task can assume about the project it is run against.
 *
 * **This duplicates `TEMPLATE_DEV_PORT` from `@nap/sandbox`, and it has to.** `docs/adr/0001`
 * makes this package pure — its only workspace dependency is `@nap/shared` — so a task cannot
 * import the sandbox template it is nonetheless served from. The schema's `preview.port` exists
 * for exactly this reason and says so.
 *
 * The duplication is not left to vigilance: `apps/napbench` can see both packages, and a test
 * there asserts these two numbers are equal. If somebody moves the dev server, that test fails
 * rather than every browser check timing out against a port nothing is listening on.
 */

/** The port the template's dev server listens on. Must equal `TEMPLATE_DEV_PORT`. */
export const TEMPLATE_PREVIEW_PORT = 5173;

/**
 * How long a generated application is given to start serving.
 *
 * Generous because it is a cold Vite dev server on a sandbox that may itself have just booted,
 * and the failure this guards against is expensive in the wrong direction: a preview declared
 * dead too early fails the run outright, which reads as "the agent built something that does not
 * start" when in fact nobody waited.
 */
export const TEMPLATE_PREVIEW_TIMEOUT_MS = 90_000;
