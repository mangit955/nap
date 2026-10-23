"use client";

import { ExternalLink, Globe, RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import { normaliseRoute, previewUrlFor } from "./route-path.ts";

export function BrowserToolbar({
  route,
  previewUrl,
  onRouteChange,
  onReload,
}: {
  route: string;
  previewUrl: string | undefined;
  onRouteChange: (route: string) => void;
  onReload: () => void;
}) {
  const [draft, setDraft] = useState(route);
  useEffect(() => setDraft(route), [route]);
  return (
    <div className="t3-browser-toolbar">
      <Globe size={14} className="shrink-0 text-muted" />
      <form
        className="min-w-0 flex-1"
        onSubmit={(event) => {
          event.preventDefault();
          onRouteChange(normaliseRoute(draft));
        }}
      >
        <input
          aria-label="Page to show"
          title="Preview path. Navigation inside the app is controlled by the app."
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => setDraft(route)}
          spellCheck={false}
          disabled={!previewUrl}
        />
      </form>
      {previewUrl && (
        <>
          <button
            type="button"
            className="t3-icon-button"
            aria-label="Reload the preview"
            title="Reload"
            onClick={onReload}
          >
            <RotateCw />
          </button>
          <a
            className="t3-icon-button"
            aria-label="Open the preview in a new tab"
            title="Open in browser"
            href={previewUrlFor(previewUrl, route)}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink />
          </a>
        </>
      )}
    </div>
  );
}
