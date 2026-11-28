import { z } from "zod";
import { LiveSidebarSettings } from "../../../settings/sidebar-settings.tsx";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ draft?: string | string[] }>;
}) {
  const params = await searchParams;
  return <LiveSidebarSettings draftId={z.uuid().safeParse(params.draft).data} />;
}
