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
 *     shell commands, which a client cannot replay. `recording.test.ts` checks each full read the
 *     agent made against them, so a wrong revision fails the suite instead of showing quietly.
 *   - **`builds`** stand in for the preview. The sandbox behind a recorded session is gone, so its
 *     address answers nothing; each build is the app's own source at that point, built to static
 *     files under `public/replays/` and shown from the `seq` given.
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
