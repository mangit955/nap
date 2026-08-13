/**
 * One icon set, drawn once.
 *
 * The workspace used to draw its arrows with the text character `▸`, which is a different shape,
 * weight and baseline in every font a browser might fall back to — so a disclosure triangle in
 * the file tree never quite lined up with the one in the transcript. These are all the same 16px
 * grid, the same 1.4 stroke, the same round joins, and they inherit `currentColor`, which is what
 * lets one component tint an icon by setting text colour.
 *
 * **Every `<svg>` writes its own `aria-hidden`.** The buttons these sit in carry their own
 * labels, so an icon that announced itself would have every control read out twice — and the lint
 * rule that insists an icon be either labelled or hidden cannot see through the spread of
 * `STROKE`, so the attribute cannot be folded into it.
 */

const STROKE = {
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/** What every icon here accepts. `className` is how a caller sets the size and the colour. */
export type IconProps = { className?: string };

export function ChevronRight({ className = "size-4" }: IconProps) {
  return (
    <svg aria-hidden="true" {...STROKE} className={className}>
      <path d="m6 3.5 5 4.5-5 4.5" />
    </svg>
  );
}

export function ChevronDown({ className = "size-4" }: IconProps) {
  return (
    <svg aria-hidden="true" {...STROKE} className={className}>
      <path d="m3.5 6 4.5 5 4.5-5" />
    </svg>
  );
}

export function FolderIcon({ className = "size-4" }: IconProps) {
  return (
    <svg aria-hidden="true" {...STROKE} className={className}>
      <path d="M2 4.2a1 1 0 0 1 1-1h2.8l1.2 1.6H13a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
    </svg>
  );
}

export function FileIcon({ className = "size-4" }: IconProps) {
  return (
    <svg aria-hidden="true" {...STROKE} className={className}>
      <path d="M9 2H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6z" />
      <path d="M9 2v4h4" />
    </svg>
  );
}

/* The six tools, each with the shape its verb suggests. See `chat/tool-step.tsx`. */

export function EyeIcon({ className = "size-4" }: IconProps) {
  return (
    <svg aria-hidden="true" {...STROKE} className={className}>
      <path d="M1.5 8S4 3.8 8 3.8 14.5 8 14.5 8 12 12.2 8 12.2 1.5 8 1.5 8" />
      <circle cx="8" cy="8" r="1.9" />
    </svg>
  );
}

export function PencilIcon({ className = "size-4" }: IconProps) {
  return (
    <svg aria-hidden="true" {...STROKE} className={className}>
      <path d="M11.2 2.6a1.4 1.4 0 0 1 2 2L5.6 12.2 2.8 13.2l1-2.8z" />
    </svg>
  );
}

export function TrashIcon({ className = "size-4" }: IconProps) {
  return (
    <svg aria-hidden="true" {...STROKE} className={className}>
      <path d="M3.5 5h9" />
      <path d="M6 5V3.5h4V5M4.5 5l.7 8h5.6l.7-8" />
      <path d="M6.8 7.2v3.6M9.2 7.2v3.6" />
    </svg>
  );
}

export function TerminalIcon({ className = "size-4" }: IconProps) {
  return (
    <svg aria-hidden="true" {...STROKE} className={className}>
      <path d="m3 5 3 3-3 3" />
      <path d="M8 11.5h5" />
    </svg>
  );
}

export function SearchIcon({ className = "size-4" }: IconProps) {
  return (
    <svg aria-hidden="true" {...STROKE} className={className}>
      <circle cx="7.2" cy="7.2" r="4.2" />
      <path d="m10.4 10.4 3 3" />
    </svg>
  );
}

export function ListIcon({ className = "size-4" }: IconProps) {
  return (
    <svg aria-hidden="true" {...STROKE} className={className}>
      <path d="M6 4.2h7.5M6 8h7.5M6 11.8h7.5" />
      <path d="M2.8 4.2h.01M2.8 8h.01M2.8 11.8h.01" strokeWidth="1.8" />
    </svg>
  );
}

/* The three states a group of actions can be in. */

/**
 * A ring with a gap in it, turning.
 *
 * The rotation is a class rather than an inline `animation` so `prefers-reduced-motion` can stop
 * it through the cascade — turning off an inline animation needs `!important`, which reverses
 * precedence for every rule after it.
 */
export function SpinnerIcon({ className = "size-4" }: IconProps) {
  return (
    <svg aria-hidden="true" {...STROKE} className={`nap-spin ${className}`}>
      <path d="M14 8a6 6 0 1 1-2.2-4.6" />
    </svg>
  );
}

export function CheckIcon({ className = "size-4" }: IconProps) {
  return (
    <svg aria-hidden="true" {...STROKE} className={className}>
      <path d="m3.2 8.4 3.2 3.2 6.4-7.2" />
    </svg>
  );
}

export function AlertIcon({ className = "size-4" }: IconProps) {
  return (
    <svg aria-hidden="true" {...STROKE} className={className}>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M8 5.2v3.4" />
      <path d="M8 10.7h.01" strokeWidth="1.8" />
    </svg>
  );
}

export function ReloadIcon({ className = "size-4" }: IconProps) {
  return (
    <svg aria-hidden="true" {...STROKE} className={className}>
      <path d="M13 8a5 5 0 1 1-1.6-3.7" />
      <path d="M13.2 2.6v2.6h-2.6" />
    </svg>
  );
}

export function ExternalIcon({ className = "size-4" }: IconProps) {
  return (
    <svg aria-hidden="true" {...STROKE} className={className}>
      <path d="M9.5 3h3.5v3.5" />
      <path d="m13 3-5 5" />
      <path d="M12 10v2.5a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5v-8a.5.5 0 0 1 .5-.5H6" />
    </svg>
  );
}

export function PanelIcon({ open, className = "size-4" }: IconProps & { open: boolean }) {
  return (
    <svg aria-hidden="true" {...STROKE} className={className}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M6.5 3v10" />
      {/* Filled while the chat is showing, so the button reads as a state as well as an action. */}
      {open && <path d="M4.2 3.2v9.6" strokeWidth="2.6" />}
    </svg>
  );
}

export function CloseIcon({ className = "size-4" }: IconProps) {
  return (
    <svg aria-hidden="true" {...STROKE} className={className}>
      <path d="m4 4 8 8M12 4l-8 8" />
    </svg>
  );
}
