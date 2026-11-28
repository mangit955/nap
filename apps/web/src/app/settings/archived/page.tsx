import { z } from "zod";
import { LiveArchivedSessions } from "../../../settings/archived-sessions.tsx";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ draft?: string | string[] }>;
}) {
  const params = await searchParams;
  return <LiveArchivedSessions draftId={z.uuid().safeParse(params.draft).data} />;
}
