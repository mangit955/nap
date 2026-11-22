"use client";

/**
 * Copies a figure's text. It says so for a moment afterwards, because a click that changes nothing
 * on screen reads as a click that did nothing.
 *
 * A clipboard that refuses — an insecure origin, a denied permission — leaves the label as it was
 * rather than claiming a copy that did not happen.
 */

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

const CONFIRM_MS = 1600;

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), CONFIRM_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      className="docs-copy"
      aria-label={label}
      onClick={() => {
        navigator.clipboard?.writeText(text).then(
          () => setCopied(true),
          () => {},
        );
      }}
    >
      {copied ? <Check aria-hidden="true" size={13} /> : <Copy aria-hidden="true" size={13} />}
      <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}
