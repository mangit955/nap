import { z } from "zod";
import { LiveGitHubConnections } from "../../../../github/live-connections.tsx";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  return (
    <LiveGitHubConnections
      draftId={z.uuid().safeParse(params.draft).data}
      callbackStatus={typeof params.github === "string" ? params.github : undefined}
    />
  );
}
