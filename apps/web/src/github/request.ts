import type { z } from "zod";
import type { FetchJson } from "../files/use-project-files.ts";

export const GITHUB_API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export async function githubRequest<T>(
  fetchJson: FetchJson,
  url: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<
  | { ok: true; value: T }
  /** `code` is the server's machine-readable reason, when it gave one — what a caller branches on. */
  | { ok: false; error: string; code?: string | undefined }
> {
  try {
    const response = await fetchJson(url, init);
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error =
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        typeof body.error === "string"
          ? body.error
          : "GitHub could not complete that request. Try again.";
      const code =
        typeof body === "object" && body !== null && "code" in body && typeof body.code === "string"
          ? body.code
          : undefined;
      return { ok: false, error, code };
    }
    const parsed = schema.safeParse(body);
    return parsed.success
      ? { ok: true, value: parsed.data }
      : { ok: false, error: "The server sent an unexpected response. Try again." };
  } catch {
    return { ok: false, error: "Could not reach the server. Check your connection and try again." };
  }
}
