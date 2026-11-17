/**
 * A replay: one real session's log, kept with everything needed to play it back with nothing
 * running.
 *
 * A visitor without an API key can run nothing on this deployment, and a live session costs a
 * model and a sandbox per view. A replay costs neither, because everything it shows is in the file:
 *
 *   - **`events`** is the log exactly as the session wrote it, parsed against today's contract.
 *   - **`files`** is the project as the session found it, so the Code tab has something to open
 *     before the agent has touched anything.
 *   - **`revisions`** is every file the session changed, in full, at the `seq` of the
 *     `file.changed` that announced it. Worked out when the recording is made rather than by
 *     re-running tool calls here, because an agent also changes files through `apply_patch` and
 *     shell commands, which a client cannot replay. `recording.test.ts` applies each
 *     `file.changed` diff in the log to the file before it and requires the revision it produces,
 *     so a wrong revision fails the suite instead of showing quietly.
 *   - **`builds`** stand in for the preview. The sandbox behind a recorded session is gone, so its
 *     address answers nothing; each build is the app's own source at that point, built to static
 *     files under `public/replays/` and shown from the `seq` given.
 *
 * **Making one.** Start from a stored log of a real session that ended verified — a run's
 * trajectory, or the session's rows read out of `events` — and the template the session started
 * from, at the commit it ran on (`git archive <commit> packages/sandbox/template`). `files` is that
 * template without `node_modules` or a lockfile. Walk the log: for each `file.changed`, apply the
 * write that announced it (`write_file`'s contents, `edit_file`'s replacement, a patch) and record
 * the whole file as a revision at that `seq`; `recording.test.ts` then checks the result against
 * the log's diffs and every full read the agent made. For each point the preview should change, install the template's
 * dependencies, `vite build --base ./` the source as it stood, and copy `dist` to
 * `public/replays/<slug>/<name>/`. Register the file in `replays.ts`. Grep the result for addresses,
 * keys and home directories before committing — the test does too. When the event contract changes
 * so an old recording no longer parses, the site's build fails on it: migrate the recording the way
 * the stored rows are migrated, or drop it.
 *
 * Nothing in a recording may be invented. A replay that drew a made-up session in the real UI
 * would be a claim about what the product did that nobody can check, which is the one thing it
 * exists to avoid.
 */

import { NapEventSchema } from "@nap/shared/events";
import { ProjectPathSchema } from "@nap/shared/files-protocol";
import { z } from "zod";

const ReplayBuildSchema = z.strictObject({
  /** The first `seq` at which this build is what the preview showed. */
  fromSeq: z.int().positive(),
  /** A static page this deployment serves itself, so the frame never reaches another host. */
  path: z.string().regex(/^\/replays\/[a-z0-9-]+\/[a-z0-9-]+\/index\.html$/),
});

const ReplayRevisionSchema = z.strictObject({
  seq: z.int().positive(),
  path: ProjectPathSchema,
  contents: z.string(),
});

export const ReplayRecordingSchema = z
  .strictObject({
    slug: z.string().regex(/^[a-z0-9-]+$/),
    title: z.string().min(1),
    recordedAt: z.iso.datetime(),
    model: z.string().min(1),
    /** Where the log came from, so anybody can ask whether it is real. */
    source: z.string().min(1),
    files: z.record(ProjectPathSchema, z.string()),
    revisions: z.array(ReplayRevisionSchema),
    builds: z.array(ReplayBuildSchema).min(1),
    events: z.array(NapEventSchema).min(1),
  })
  .refine((recording) => recording.events.every((event, index) => event.seq === index + 1), {
    message: "events must be the whole log, numbered from 1 without gaps",
  });

export type ReplayRecording = z.infer<typeof ReplayRecordingSchema>;
