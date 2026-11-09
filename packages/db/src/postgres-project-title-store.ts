import type {
  ProjectTitleStore,
  TitleClaim,
  TitleMode,
} from "@nap/shared/ports/project-title-store";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";

/** A claim older than this was abandoned by a process that died; a new one may take over. */
export const TITLE_CLAIM_EXPIRY = "2 minutes";
/** How soon after one title request another may be made, so clicks cannot run up a bill. */
export const TITLE_COOLDOWN = "10 seconds";

const Claimed = z.object({ generation: z.uuid(), name: z.string() });
const Context = z.object({
  session_id: z.uuid().nullable(),
  source_name: z.string().nullable(),
});
const Message = z.object({ text: z.string(), seq: z.number().int() });

export class PostgresProjectTitleStore implements ProjectTitleStore {
  constructor(private readonly db: PostgresJsDatabase) {}

  async claim(projectId: string, userId: string, mode: TitleMode): Promise<TitleClaim | null> {
    const automatic = mode === "automatic";
    const [claimed] = await this.db.execute(sql`
      update projects set
        title_generation = gen_random_uuid(),
        title_requested_at = now(),
        title_auto_attempted = title_auto_attempted or ${automatic}
      where id = ${projectId} and user_id = ${userId}
        and (title_generation is null
          or title_requested_at < now() - ${TITLE_CLAIM_EXPIRY}::interval)
        and (title_requested_at is null
          or title_requested_at < now() - ${TITLE_COOLDOWN}::interval)
        and (${!automatic} or (name_source = 'seed' and not title_auto_attempted))
      returning title_generation as generation, name
    `);
    if (claimed === undefined) return null;
    const { generation, name } = Claimed.parse(claimed);

    const [context] = await this.db.execute(sql`
      select
        (select id from sessions where project_id = ${projectId}
          order by created_at desc, id desc limit 1) as session_id,
        (select repository->>'fullName' from project_repositories
          where project_id = ${projectId}) as source_name
    `);
    const { session_id: sessionId, source_name: sourceName } = Context.parse(context);
    if (sessionId === null) {
      await this.release(projectId, generation);
      return null;
    }
    // The first message says what the session is for; the latest say whether that changed.
    const rows = await this.db.execute(sql`
      (select payload->>'text' as text, seq from events
        where session_id = ${sessionId} and type = 'user.message' and not (payload ? 'repair')
        order by created_at, seq limit 1)
      union
      (select payload->>'text' as text, seq from events
        where session_id = ${sessionId} and type = 'user.message' and not (payload ? 'repair')
        order by created_at desc, seq desc limit 3)
      order by seq
    `);
    return {
      generation,
      currentName: name,
      sessionId,
      messages: rows.map((row) => Message.parse(row).text),
      sourceName,
    };
  }

  async apply(
    projectId: string,
    generation: string,
    name: string,
    mode: TitleMode,
  ): Promise<boolean> {
    // The claim is the authority: every rename by the person clears it in the statement that
    // makes the name theirs. An automatic title also refuses a `user` name outright, so even a
    // claim nobody cleared can never overwrite one (docs/adr/0031 D3).
    const rows = await this.db.execute(sql`
      update projects set
        name = ${name}, name_source = 'model', title_generation = null, updated_at = now()
      where id = ${projectId} and title_generation = ${generation}
        ${mode === "automatic" ? sql`and name_source <> 'user'` : sql``}
      returning id
    `);
    return rows.length > 0;
  }

  async release(projectId: string, generation: string): Promise<void> {
    await this.db.execute(sql`
      update projects set title_generation = null
      where id = ${projectId} and title_generation = ${generation}
    `);
  }
}
