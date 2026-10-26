import { LandingDesktopDemo } from "../../../landing/landing-desktop-demo.tsx";
import { StoryChapterSchema, StoryThreadSchema } from "../../../landing/story-demo-protocol.ts";

export const metadata = { title: "Nap example session", robots: { index: false, follow: false } };

export default async function LandingDemoPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const thread = StoryThreadSchema.safeParse(params.thread);
  const chapter = StoryChapterSchema.safeParse(params.chapter);
  return (
    <LandingDesktopDemo
      initialThread={thread.success ? thread.data : "finance"}
      initialChapter={chapter.success ? chapter.data : "describe"}
    />
  );
}
