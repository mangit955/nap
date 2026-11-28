import type { ReactNode } from "react";

/**
 * The head every numbered section opens with: `[01] How it works` over a dot-matrix title, and a
 * sentence beside it, ruled off from the body below.
 */
export function SectionHead({
  id,
  index,
  label,
  title,
  children,
}: {
  /** The heading's id, which the section names itself by. */
  id: string;
  index: string;
  label: string;
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="n1-head">
      <div>
        <div className="n1-label">
          <b>[{index}]</b> {label}
        </div>
        <h2 id={id} className="n1-dot">
          {title}
        </h2>
      </div>
      <div className="n1-head-aside">{children}</div>
    </div>
  );
}
