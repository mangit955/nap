import { redirect } from "next/navigation";
import { z } from "zod";
import { LiveConnectionsOverview } from "../../../github/live-connections.tsx";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const draftId = z.uuid().safeParse(params.draft).data;
  // GitHub's callback result belongs to the GitHub page. An API deployed before that page
  // existed still returns here, so its result is passed along rather than dropped.
  if (typeof params.github === "string")
    redirect(
      `/settings/connections/github?github=${encodeURIComponent(params.github)}${draftId ? `&draft=${draftId}` : ""}`,
    );
  return <LiveConnectionsOverview draftId={draftId} />;
}
