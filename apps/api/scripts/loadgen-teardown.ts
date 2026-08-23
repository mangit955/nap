/**
 * What a deployed load run leaves behind, and how it goes away.
 *
 * `docs/scaling-design.md` §24 item 6. A ramp to 100 signs in through the demo door a hundred
 * times — the only path k6 can drive without OAuth, and a real code path, which is the point —
 * and every one of those identities keeps a project, a session and the whole event log of the
 * turns it ran. Nothing else collects them. Run this after a deployed run:
 *
 *   bun run loadgen:teardown --older-than-minutes=60            # what it would take
 *   bun run loadgen:teardown --older-than-minutes=60 --confirm  # take it
 *
 * `DATABASE_URL` is where it looks, so it is pointed at a deployment by the environment rather
 * than by a flag somebody could get wrong while it is running against production.
 *
 * **It cannot tell a load run's identity from a real visitor's, and neither can the database.**
 * Age is the whole tenancy — see `purgeDemoUsers`, which explains why a test-only tenant was
 * rejected — so pointed at the public deployment this deletes the projects and transcripts of
 * *anyone* who came in through the demo door and has been away for the window. That is a
 * decision somebody has to make on purpose, which is why there is no default window and why the
 * destructive pass needs `--confirm`: a bare invocation reports and exits, whatever it is
 * pointed at.
 *
 * **Sandboxes are the part Postgres cannot do.** A deleted project's sandbox is still running on
 * E2B, and once the row is gone the reaper will not touch it either — a sandbox whose project
 * this database does not know is left alone on purpose, so that a benchmark run on the same
 * account is not killed by somebody else's tidy-up. So they are destroyed here, before the rows
 * go, and a run that finds some with no E2B credentials to hand refuses rather than leaking them
 * quietly.
 */

import { createDatabase } from "@nap/db/client";
import { purgeDemoUsers } from "@nap/db/purge-demo-users";
import { E2BSandboxManager } from "@nap/sandbox/e2b-sandbox-manager";
import { z } from "zod";

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function argument(name: string, fallback: string): string {
  return (
    process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
  );
}

/** Parsed rather than cast, for the reason `loadgen-ramp.ts` gives: `Number("nonsense")` is NaN. */
const ArgumentsSchema = z.object({
  olderThanMinutes: z
    .string()
    .regex(/^\d+$/, "must be a whole number of minutes")
    .transform(Number),
  limit: z.string().regex(/^\d+$/, "must be a whole number").transform(Number),
});

// No default. A window is a claim about who has gone home and is not coming back, and it depends
// on the deployment — an hour is right after a load run against a throwaway cluster and reckless
// against the public one, where somebody's demo project is an hour old the moment they make it.
const parsed = ArgumentsSchema.safeParse({
  olderThanMinutes: argument("older-than-minutes", ""),
  limit: argument("limit", "500"),
});

if (!parsed.success) {
  for (const issue of parsed.error.issues) {
    console.error(`--${issue.path.join(".")}: ${issue.message}`);
  }
  console.error(
    "\n  bun run loadgen:teardown --older-than-minutes=60            # what it would take" +
      "\n  bun run loadgen:teardown --older-than-minutes=60 --confirm  # take it",
  );
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl === "") {
  console.error("DATABASE_URL is required — this script is pointed at a deployment by its env.");
  process.exit(1);
}

// Reporting is the default and deleting is the flag, which is the way round that makes a
// mistyped command harmless. `--dry-run` is still accepted, because that is what somebody types.
const confirmed = flag("confirm") && !flag("dry-run");
const { db, close } = createDatabase(databaseUrl);

/**
 * The sandboxes first, and the rows only if they all went.
 *
 * The other order loses the ids: the sandbox is named by the project, and the project is what the
 * cascade removes. So the dry run is what decides, and the delete follows it.
 */
const planned = await purgeDemoUsers(db, {
  olderThanMinutes: parsed.data.olderThanMinutes,
  limit: parsed.data.limit,
  dryRun: true,
});

console.log(
  `${planned.userIds.length} demo identities older than ${parsed.data.olderThanMinutes} minutes,` +
    ` holding ${planned.projectCount} projects and ${planned.orphanedSandboxIds.length} live sandboxes.`,
);

if (!confirmed) {
  for (const id of planned.orphanedSandboxIds) console.log(`  sandbox ${id} would be destroyed`);
  console.log("\nNothing was deleted. Add --confirm to take it.");
  await close();
  process.exit(0);
}

if (planned.orphanedSandboxIds.length > 0) {
  if ((process.env.E2B_API_KEY ?? "") === "") {
    // Refusing is the whole point: deleting these rows without a key leaves running sandboxes
    // that nothing in the system will ever find again, billing until their TTL.
    console.error(
      `E2B_API_KEY is unset and ${planned.orphanedSandboxIds.length} projects still name a sandbox.` +
        ` Deleting them now would leak every one — set the key, or wait for the reaper to put them away.`,
    );
    await close();
    process.exit(1);
  }

  const sandboxes = new E2BSandboxManager();
  for (const id of planned.orphanedSandboxIds) {
    const destroyed = await sandboxes.destroy(id);
    // A sandbox E2B has already reclaimed is the ordinary case an hour after a run, and it is
    // not a reason to leave the rows: what matters is that nothing is still running.
    console.log(
      `  sandbox ${id}: ${destroyed.ok ? "destroyed" : `${destroyed.error.code}: ${destroyed.error.message}`}`,
    );
  }
}

const purged = await purgeDemoUsers(db, {
  olderThanMinutes: parsed.data.olderThanMinutes,
  limit: parsed.data.limit,
});
console.log(`Deleted ${purged.userIds.length} identities and ${purged.projectCount} projects.`);

await close();
