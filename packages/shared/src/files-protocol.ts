/**
 * What the file-browsing endpoints answer with.
 *
 * The API and the browser are written in different tasks and deploy separately, so these
 * are a contract rather than an understanding — defined once here and validated at both
 * ends, the way `ws-protocol.ts` defines what travels over the socket.
 *
 * **Every path here is relative to the project root.** Where the project lives inside a
 * sandbox is an execution-plane detail; a client that learned the absolute prefix would
 * start echoing it back, and the day the template's working directory moves, every stored
 * path in the browser would be wrong. The events the agent emits *do* carry absolute paths
 * — they come straight from the tools — so anything matching the two up has exactly one
 * place to normalize, and it is on the client side of this boundary.
 */

import { z } from "zod";

/**
 * Where a project lives inside its sandbox.
 *
 * Stated here as well as in the sandbox template and the agent's tool definitions, because
 * those two are contracts with an image and with a model respectively, and neither package
 * is one a browser should import. `test/project-root.test.ts` fails if the copies drift.
 *
 * A client needs it for exactly one thing: the events the agent emits carry the absolute
 * paths its tools were given, while these endpoints speak in project-relative ones, and
 * matching a changed file against the tree means putting the two in the same form.
 */
export const PROJECT_ROOT_PATH = "/home/user/app";

/** The project-relative form of a path the agent reported. Anything already relative passes. */
export function toProjectPath(path: string): string {
  const prefix = `${PROJECT_ROOT_PATH}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** A path a client may ask about: relative, inside the project, and not a directory trick. */
export const ProjectPathSchema = z
  .string()
  .min(1)
  .refine((path) => !path.startsWith("/"), { message: "must be relative to the project root" })
  .refine((path) => !path.split("/").includes(".."), { message: "must not leave the project" })
  .refine((path) => !path.includes("\0"), { message: "must not contain a null byte" })
  /**
   * One canonical spelling per file. `src//App.tsx` and `src/./App.tsx` name the same file as
   * `src/App.tsx`, and a client that has to guess which spelling it will get back cannot use
   * the path as a key — which is exactly what a tree and a viewer both do with it.
   */
  .refine((path) => path.split("/").every((segment) => segment !== "" && segment !== "."), {
    message: "must not contain empty or '.' segments",
  });

/**
 * The project's files.
 *
 * `ready: false` is a session whose sandbox has not been created yet — the first turn is
 * still starting, or none has been sent. It is an ordinary state with an empty list, not an
 * error, because a tree that renders a failure before the user has done anything is a lie.
 */
export const FileListingSchema = z.strictObject({
  ready: z.boolean(),
  files: z.array(ProjectPathSchema),
  /** Whether a limit stopped the walk before it ran out of project. */
  truncated: z.boolean(),
});
export type FileListing = z.infer<typeof FileListingSchema>;

/** One file's contents. `truncated` means `contents` is a prefix of a larger file. */
export const FileContentSchema = z.strictObject({
  path: ProjectPathSchema,
  contents: z.string(),
  truncated: z.boolean(),
  /** The size of the whole file, so a truncated view can say how much is missing. */
  bytes: z.int().nonnegative(),
});
export type FileContent = z.infer<typeof FileContentSchema>;
