"use client";

import {
  GitHubConnectionsSchema,
  GitHubRepositoriesSchema,
  type GitHubRepository,
} from "@nap/shared/github-protocol";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { credentialedFetch } from "../api/credentialed-fetch.ts";
import type { FetchJson } from "../files/use-project-files.ts";
import { GITHUB_API_URL, githubRequest } from "./request.ts";

export type RepositoryChoice = { installationId: number; repository: GitHubRepository };
type ListState =
  | { kind: "loading" }
  | { kind: "disconnected" }
  | { kind: "loaded"; choices: RepositoryChoice[]; errors: string[] };

export function RepositoryPicker({
  onSelect,
  onClose,
  onConnect,
  selected,
  fetchJson = credentialedFetch,
  baseUrl = GITHUB_API_URL,
}: {
  onSelect: (choice: RepositoryChoice) => void;
  onClose: () => void;
  onConnect: () => void;
  selected?: RepositoryChoice | undefined;
  fetchJson?: FetchJson;
  baseUrl?: string;
}) {
  const [state, setState] = useState<ListState>({ kind: "loading" });
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const load = useCallback(async (): Promise<ListState> => {
    const connection = await githubRequest(
      fetchJson,
      `${baseUrl}/github/connections`,
      GitHubConnectionsSchema,
    );
    if (!connection.ok) return { kind: "loaded", choices: [], errors: [connection.error] };
    const installations = connection.value.installations.filter((item) => item.status === "active");
    if (!installations.length) return { kind: "disconnected" };
    const choices: RepositoryChoice[] = [];
    const errors: string[] = [];
    // The installation endpoint traverses GitHub pagination and checks the connected user's
    // write permission. Read every installation, including ones without any imported projects.
    for (const installation of installations) {
      const result = await githubRequest(
        fetchJson,
        `${baseUrl}/github/installations/${installation.installationId}/repositories`,
        GitHubRepositoriesSchema,
      );
      if (result.ok)
        choices.push(
          ...result.value.repositories.map((repository) => ({
            installationId: installation.installationId,
            repository,
          })),
        );
      else errors.push(`${installation.accountLogin}: ${result.error}`);
    }
    choices.sort((a, b) => a.repository.fullName.localeCompare(b.repository.fullName));
    return { kind: "loaded", choices, errors };
  }, [fetchJson, baseUrl]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly retries the same load.
  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    void load().then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [load, attempt]);
  useEffect(() => {
    input.current?.focus();
  }, []);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) onClose();
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [onClose]);
  const choices =
    state.kind === "loaded"
      ? state.choices.filter((item) =>
          item.repository.fullName.toLowerCase().includes(query.trim().toLowerCase()),
        )
      : [];
  const current = choices.length ? Math.min(highlight, choices.length - 1) : -1;
  return (
    <div ref={root} className="repository-mention">
      <div className="repository-mention-line">
        <label htmlFor={`${listId}-input`}>@repos:</label>
        <input
          ref={input}
          id={`${listId}-input`}
          role="combobox"
          aria-label="Filter authorized repositories"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={current < 0 ? undefined : `${listId}-${current}`}
          autoComplete="off"
          placeholder="Filter repositories…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setHighlight(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            }
            if (event.key === "Tab") onClose();
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const next = choices.length
                ? (current + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length
                : 0;
              setHighlight(next);
              document.getElementById(`${listId}-${next}`)?.scrollIntoView?.({ block: "nearest" });
            }
            if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              const choice = choices[current];
              if (choice) onSelect(choice);
            }
          }}
        />
      </div>
      <div className="repository-popover composer-surface nap-float">
        <div className="repository-heading">Repositories</div>
        <div
          id={listId}
          role="listbox"
          aria-label="Authorized GitHub repositories"
          className="repository-list nap-scroll-hidden"
        >
          {choices.map((choice, index) => (
            <button
              key={`${choice.installationId}-${choice.repository.id}`}
              id={`${listId}-${index}`}
              type="button"
              role="option"
              tabIndex={-1}
              aria-label={choice.repository.fullName}
              aria-selected={
                selected?.installationId === choice.installationId &&
                selected.repository.id === choice.repository.id
              }
              title={`${choice.repository.fullName}${choice.repository.private ? " · Private" : ""}`}
              data-highlighted={current === index}
              onMouseEnter={() => setHighlight(index)}
              onClick={() => onSelect(choice)}
              className="repository-option"
            >
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.86c-2.78.6-3.37-1.18-3.37-1.18-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.64-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.99 1.03-2.69-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.03A9.6 9.6 0 0 1 12 6.82a9.6 9.6 0 0 1 2.5.34c1.91-1.3 2.75-1.03 2.75-1.03.55 1.38.2 2.4.1 2.65.64.7 1.03 1.6 1.03 2.69 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85v2.75c0 .27.18.58.69.48A10 10 0 0 0 12 2Z" />
              </svg>
              <span>{choice.repository.fullName.split("/")[1]}</span>
              {current === index && <small>{choice.repository.fullName.split("/")[0]}</small>}
            </button>
          ))}
        </div>
        {state.kind === "loading" && (
          <p role="status" className="repository-message">
            Loading repositories…
          </p>
        )}
        {state.kind === "disconnected" && (
          <p className="repository-message">
            Connect GitHub in{" "}
            <button type="button" onClick={onConnect}>
              Settings → Connections
            </button>
            .
          </p>
        )}
        {state.kind === "loaded" && (
          <>
            {!choices.length && (
              <p className="repository-message">
                {query
                  ? "No matching repositories."
                  : "No repositories available with write access."}
              </p>
            )}
            {state.errors.map((error) => (
              <p key={error} role="alert" className="repository-message">
                {error}
              </p>
            ))}
            {state.errors.length > 0 && (
              <button
                type="button"
                className="repository-retry"
                onClick={() => setAttempt(attempt + 1)}
              >
                Retry
              </button>
            )}
            <button type="button" className="repository-settings" onClick={onConnect}>
              Manage access in Settings → Connections
            </button>
          </>
        )}
      </div>
    </div>
  );
}
