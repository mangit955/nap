import { getLogger } from "@nap/shared/logging";
import type { EventBus } from "@nap/shared/ports/event-bus";
import type { EventStore } from "@nap/shared/ports/event-store";
import type { LLMProvider, ModelCredentials } from "@nap/shared/ports/llm-provider";
import type { ProjectTitleStore, TitleMode } from "@nap/shared/ports/project-title-store";
import {
  cleanTitle,
  TITLE_MAX_OUTPUT_TOKENS,
  TITLE_SYSTEM_PROMPT,
  titlePrompt,
} from "@nap/shared/session-title";

/**
 * Who pays for a title, and on which model: the same answer a turn by this person would get, or
 * null when there is none (docs/adr/0031 D4).
 */
export type TitleAccess = (
  userId: string,
) => Promise<{ model: string; credentials?: ModelCredentials | undefined } | null>;

export type TitleOutcome =
  | { kind: "titled"; name: string }
  /** Another title is in flight, one was asked for moments ago, or the automatic one was had. */
  | { kind: "busy" }
  /** The name stays as it was; `reason` is for the caller and the log, never the person's chat. */
  | {
      kind: "kept";
      reason: "no_access" | "nothing_to_title" | "refused" | "failed" | "invalid" | "renamed";
    };

export type TitleRequest = {
  projectId: string;
  userId: string;
  mode: TitleMode;
  /**
   * The prompt being admitted, for the automatic title: it is not in the log yet, because the
   * runtime writes it when the turn starts. Absent, the person's messages are read from the log.
   */
  message?: string | undefined;
};

/** What a route needs: one call, which never throws. */
export interface SessionTitles {
  title(request: TitleRequest): Promise<TitleOutcome>;
}

/** Long enough for a slow model on a busy route; short enough to wait on from a button. */
const TITLE_TIMEOUT_MS = 20_000;

/**
 * Writes a session's title with a model (docs/adr/0031).
 *
 * Every failure is a value and leaves the current name in place. The only writes are the claim,
 * the conditional apply and the release, so a rename by the person always wins, and two titles
 * for one project are never written at once.
 */
export class SessionTitler implements SessionTitles {
  constructor(
    private readonly deps: {
      store: ProjectTitleStore;
      provider: LLMProvider;
      access: TitleAccess;
      events: EventStore;
      bus: EventBus;
      timeoutMs?: number;
    },
  ) {}

  async title(request: TitleRequest): Promise<TitleOutcome> {
    const { store, provider } = this.deps;
    const { projectId, mode } = request;
    const log = getLogger().child({ projectId });

    let claim: Awaited<ReturnType<ProjectTitleStore["claim"]>>;
    try {
      claim = await store.claim(projectId, request.userId, mode);
    } catch (error) {
      log.warn({ err: error }, "could not claim a session title");
      return { kind: "kept", reason: "failed" };
    }
    if (claim === null) return { kind: "busy" };
    const { generation } = claim;
    const keep = async (reason: Extract<TitleOutcome, { kind: "kept" }>["reason"]) => {
      await store.release(projectId, generation).catch((error: unknown) => {
        log.warn({ err: error }, "could not release a session title claim");
      });
      log.info({ reason, mode }, "session title kept");
      return { kind: "kept", reason } as const;
    };

    try {
      const access = await this.deps.access(request.userId);
      if (access === null) return await keep("no_access");
      const messages = request.message === undefined ? claim.messages : [request.message];
      if (messages.length === 0) return await keep("nothing_to_title");

      const result = await provider
        .startTurn({ model: access.model, credentials: access.credentials })
        .complete({
          purpose: "title",
          maxOutputTokens: TITLE_MAX_OUTPUT_TOKENS,
          systemPrompt: TITLE_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: titlePrompt(
                mode === "manual" ? { messages, previousTitle: claim.currentName } : { messages },
              ),
            },
          ],
          tools: [],
          signal: AbortSignal.timeout(this.deps.timeoutMs ?? TITLE_TIMEOUT_MS),
        });
      // Logged whatever happens next: a title that was refused or thrown away still cost this.
      log.info({ mode, model: access.model, ...result.usage }, "session title answered");
      if (result.type === "refusal") return await keep("refused");
      if (result.type === "error") return await keep("failed");

      const name = cleanTitle(result.text, { messages, sourceName: claim.sourceName });
      if (name === null) return await keep("invalid");
      if (!(await store.apply(projectId, generation, name, mode))) {
        // The claim is gone: the person renamed it meanwhile, and their name stands.
        log.info({ reason: "renamed", mode }, "session title kept");
        return { kind: "kept", reason: "renamed" };
      }

      try {
        const event = await this.deps.events.append({
          sessionId: claim.sessionId,
          turnId: crypto.randomUUID(),
          type: "project.renamed",
          payload: { name, source: "model", model: access.model, usage: result.usage },
          createdAt: new Date().toISOString(),
        });
        this.deps.bus.publish(event);
      } catch (error) {
        // The name is written; tabs will see it on their next read of the list.
        log.warn({ err: error }, "could not announce a session title");
      }
      return { kind: "titled", name };
    } catch (error) {
      log.warn({ err: error }, "could not write a session title");
      return await keep("failed");
    }
  }
}
