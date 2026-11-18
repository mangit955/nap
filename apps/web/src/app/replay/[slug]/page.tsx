import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ReplayShell } from "../../../replay/replay-shell.tsx";
import { findReplay, replaySlugs } from "../../../replay/replays.ts";

/**
 * A recorded session, open to anybody. No sign-in: a replay asks nothing of the API, so there is
 * nothing to protect and nothing to pay for. Built once per recording at build time, and only
 * those — a slug that names no recording is a 404 rather than a render.
 */
export const dynamicParams = false;

export function generateStaticParams() {
  return replaySlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const recording = findReplay((await params).slug);
  return {
    title: recording ? `${recording.title} · a recorded Nap session` : "nap",
    description: "A real Nap session, played back from its log.",
  };
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const recording = findReplay((await params).slug);
  if (!recording) notFound();
  return <ReplayShell recording={recording} />;
}
