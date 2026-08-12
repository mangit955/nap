"use client";

/**
 * The handle between two panes.
 *
 * **A real separator rather than a styled div**: it carries the width it controls and it answers
 * arrow keys. A handle that only followed a pointer would be unreachable for anybody who does not
 * use one — and these decide how much of the screen the transcript and the file tree get.
 *
 * `role="separator"` is written out rather than taken from an `<hr>`, whose implicit role is the
 * same. An `<hr>` is a void element, so it cannot hold the line below — and the grab area and the
 * line have to be different sizes. A one-pixel target is a target nobody hits, but a visibly
 * thick divider is a piece of furniture in the middle of the window. So the widget is seven
 * pixels wide and the line inside it is one, and `-mx-1` pulls the extra back out of the layout
 * so the two panes still meet.
 */

export function Splitter({
  label,
  value,
  onGrab,
  onKeyDown,
}: {
  /** What this handle moves, said as a thing rather than as an action. */
  label: string;
  value: number;
  onGrab: (event: React.PointerEvent) => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: an <hr> is void and cannot hold the line
    <div
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuenow={value}
      tabIndex={0}
      onPointerDown={onGrab}
      onKeyDown={onKeyDown}
      className="group relative z-10 -mx-[3px] h-full w-[7px] shrink-0 cursor-col-resize outline-none"
    >
      <span className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-edge transition-colors duration-150 group-hover:bg-line-strong group-focus-visible:bg-accent" />
    </div>
  );
}
