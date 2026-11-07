/**
 * The desktop build this runtime drives: a hash of every source the desktop image runs, from
 * `desktopBuild()` in `desktop-template.ts`. The published template carries its own build at
 * `DESKTOP_BUILD_FILE`, and the E2B adapter refuses to run a driver whose build differs, so a
 * stale template degrades computer use to unavailable instead of running an older driver
 * against newer code.
 *
 * Its own file because it cannot be one of the sources it hashes. A test fails when the
 * sources change; set this to its new value, then republish the template before deploying
 * (docs/DEPLOY.md, "Computer capability rollout").
 */
export const DESKTOP_BUILD = "a89efce587a2f872025b53c0b26ca2300af3a114491989ffa92296b0b065502c";
