import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DocsArticle } from "../../../../docs/docs-article.tsx";
import { outlineOf } from "../../../../docs/outline.ts";
import { SECTIONS } from "../../../../docs/sections.tsx";

/** Every page is known when the site is built; any other slug is a 404, not a render. */
export const dynamicParams = false;

export function generateStaticParams() {
  return SECTIONS.map(({ id }) => ({ slug: id }));
}

function sectionOf(slug: string) {
  return SECTIONS.find((section) => section.id === slug);
}

export async function generateMetadata(props: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const section = sectionOf((await props.params).slug);
  if (!section) return {};
  return { title: `${section.title} — nap docs`, description: outlineOf(section.Body).lede };
}

export default async function Page(props: { params: Promise<{ slug: string }> }) {
  const section = sectionOf((await props.params).slug);
  if (!section) notFound();
  return <DocsArticle section={section} />;
}
