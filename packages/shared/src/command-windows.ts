/**
 * How long a command the system starts for itself may run in a sandbox.
 *
 * **Every long command has to say so.** A provider stops any command after its own default, which
 * on E2B is one minute, and that default fails the same way a broken sandbox does. So a check, a
 * setup or an install that merely takes a while reads as infrastructure falling over, with nothing
 * in the code around it to suggest a limit was ever involved.
 *
 * The limits are neighbours because they are measured against the same three clocks:
 *
 *   - **The lease does not bound them.** A worker renews it throughout a turn, however long any
 *     one command takes, and hears about a lost lease within a renewal. What the lease needs from
 *     a command is that it stops when told, which is what passing the turn's signal is for.
 *   - **No wall-clock budget bounds them.** A turn is budgeted in model steps and tokens, and a
 *     check spends neither.
 *   - **The sandbox's own lifetime has to stay ahead of them.** It kills the sandbox whatever is
 *     happening inside, so a sandbox starts with the lifetime it was configured with, and the
 *     deadline is pushed back when a turn acquires an existing one and again before a round of
 *     checks.
 *
 * They live in `shared` because `@nap/verify`, `@nap/runtime` and `@nap/bench` all read them, and
 * the first has no business importing the others.
 */

/**
 * How long one verification check may run.
 *
 * Not because a longer limit would outlast the sandbox: the push before a round covers whatever the
 * round adds up to. The reasons are what that push does and who is waiting. The worst round should
 * fit the default sandbox lifetime, so that checks do not keep a sandbox alive past what a deployment
 * configured. Ten minutes, the ceiling the agent's own foreground commands have, would not. And this
 * is how long a hung check holds a worker slot. Five is well past what a generated project takes,
 * and still ends a test runner left in watch mode, and whatever it started, in a time somebody would
 * wait for.
 *
 * A check that outlives this has told us nothing about the project, so the run comes back `errored`
 * and the job closes abandoned, rather than spending a repair turn on it.
 *
 * It can outlast a worker's drain, whose length depends on the deployment. A check still running at
 * the end of one is aborted, and that reads the same way: `errored`, abandoned, no repair.
 */
export const CHECK_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * How long one whole round of checks may keep a sandbox busy, and so how far its deadline is pushed
 * back before one starts: every check at its limit, plus a minute for the preview wait and probe.
 *
 * Without the push, a turn that had already used most of the lifetime would lose its sandbox
 * halfway through a check, which is an `errored` run caused by nothing but the order of events.
 */
export const VERIFICATION_ROUND_LIMIT_MS = 4 * CHECK_TIMEOUT_MS + 60 * 1000;

/** How long an imported repository's setup command may run, enforced by `timeout` in the sandbox. */
export const SETUP_TIMEOUT_SECONDS = 600;

/**
 * How long the provider waits on that setup command.
 *
 * Deliberately later, by a margin. The script's own `timeout` is the deadline that can be reported:
 * it exits 124, while a provider that gets there first takes the exit code with it. The margin also
 * covers the process group dying after `timeout` signals it.
 */
export const SETUP_EXEC_TIMEOUT_MS = (SETUP_TIMEOUT_SECONDS + 30) * 1000;

/**
 * How long `bun install` may run when a restored project's lockfile has moved.
 *
 * Shorter than setup: a project generated from the template has far fewer dependencies than an
 * arbitrary imported repository, and someone is waiting on this one to see their project. Past it
 * the project still opens, with a warning that its dependencies did not install.
 */
export const RESTORE_INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
