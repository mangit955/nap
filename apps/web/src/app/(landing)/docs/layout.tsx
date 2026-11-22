import type { ReactNode } from "react";
import { DocsShell } from "../../../docs/docs-shell.tsx";

export default function DocsLayout({ children }: { children: ReactNode }) {
  return <DocsShell>{children}</DocsShell>;
}
