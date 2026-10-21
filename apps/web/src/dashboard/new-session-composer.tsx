"use client";

import { RepositoryImportSchema } from "@nap/shared/github-protocol";
import type { MediaAttachment } from "@nap/shared/media";
import type { ModelChoice } from "@nap/shared/models-protocol";
import { SessionStartedSchema, SessionStartSchema } from "@nap/shared/session-start-protocol";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { credentialedFetch } from "../api/credentialed-fetch.ts";
import { useMediaAttachments } from "../chat/use-media-attachments.ts";
import type { FetchJson } from "../files/use-project-files.ts";
import { type RepositoryChoice, RepositoryPicker } from "../github/repository-picker.tsx";
import { GITHUB_API_URL } from "../github/request.ts";
import { type ComposerDraft, ComposerDraftStore } from "../projects/composer-draft.ts";
import { useDraftNavigation } from "../projects/use-draft-navigation.ts";
import { DashboardHero } from "./dashboard-hero.tsx";

export function NewSessionComposer({
  ownerId,
  models,
  modelsLoading,
  fallback,
  onAddKey,
  fetchJson = credentialedFetch,
}: {
  ownerId: string;
  models: readonly ModelChoice[];
  modelsLoading: boolean;
  fallback?: string | undefined;
  onAddKey: () => void;
  fetchJson?: FetchJson;
}) {
  const router = useRouter();
  const media = useMediaAttachments();
  const [draft, setDraft] = useState<ComposerDraft>();
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const sending = useRef(false);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const store = useRef(new ComposerDraftStore());
  const pointer = `nap.composer.${ownerId}`;
  const saveTail = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    let cancelled = false;
    const restore = async () => {
      const params = new URLSearchParams(window.location.search);
      let id: string | null = null;
      try {
        id = params.get("draft") ?? sessionStorage.getItem(pointer);
        const saved = id ? await store.current.load(ownerId, id) : null;
        if (cancelled) return;
        const next: ComposerDraft = saved ?? {
          id: crypto.randomUUID(),
          ownerId,
          operationId: crypto.randomUUID(),
          text: "",
          source: null,
          attachments: [],
          expiresAt: Date.now() + 7 * 86400_000,
        };
        media.setAttachments(
          next.attachments.map((item) => ({
            id: crypto.randomUUID(),
            previewUrl: undefined,
            media: item,
          })),
        );
        setDraft(next);
        setPicker(params.has("repositories"));
        if (id && !saved) setError("That draft expired or is no longer available in this browser.");
        if (params.get("github") === "error")
          setError(
            "GitHub authorization was not completed. Your draft is here; you can reconnect or keep writing.",
          );
      } catch {
        if (!cancelled) {
          setDraft({
            id: crypto.randomUUID(),
            ownerId,
            operationId: crypto.randomUUID(),
            text: "",
            source: null,
            attachments: [],
            expiresAt: Date.now() + 7 * 86400_000,
          });
          setError(
            "Draft storage is unavailable. Keep this page open and enable browser storage before connecting GitHub.",
          );
        }
      }
    };
    void restore();
    return () => {
      cancelled = true;
    };
  }, [ownerId, pointer, media.setAttachments]);

  const snapshot = useCallback(
    (): ComposerDraft | undefined =>
      draft && {
        ...draft,
        attachments: media.attachments.map((item) => item.media),
        expiresAt: Date.now() + 7 * 86400_000,
      },
    [draft, media.attachments],
  );
  const persist = useCallback(
    async (value: ComposerDraft) => {
      const saved = saveTail.current
        .catch(() => {})
        .then(async () => {
          await store.current.save(value);
          sessionStorage.setItem(pointer, value.id);
        });
      saveTail.current = saved;
      await saved;
    },
    [pointer],
  );
  useEffect(() => {
    const value = snapshot();
    if (!value || sending.current) return;
    const timer = setTimeout(() => {
      void persist(value).catch(() =>
        setError(
          "Could not save your draft. Keep this page open and free browser storage before leaving.",
        ),
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [snapshot, persist]);
  useDraftNavigation(
    draft
      ? async () => {
          const value = snapshot();
          if (sending.current) await saveTail.current;
          else if (value) await persist(value);
        }
      : undefined,
    () =>
      setError(
        "Could not save your draft. Keep this page open and free browser storage before leaving.",
      ),
  );

  const closePicker = useCallback(() => {
    setPicker(false);
    document
      .querySelector<HTMLTextAreaElement>('textarea[aria-label="Describe the app you want"]')
      ?.focus({ preventScroll: true });
  }, []);
  const connect = async () => {
    const value = snapshot();
    if (!value || sending.current) return;
    setBusy(true);
    try {
      await persist(value);
      router.push(`/settings/connections?draft=${value.id}`);
    } catch {
      setError(
        "Could not save your draft. Stay here, free browser storage, and try connecting again.",
      );
      setBusy(false);
    }
  };
  const select = (choice: RepositoryChoice) => {
    setDraft(
      (value) =>
        value && {
          ...value,
          source: {
            ...choice,
            repositoryId: choice.repository.id,
            name: choice.repository.fullName,
            baseBranch: choice.repository.defaultBranch,
            environment: { setupCommand: null, devCommand: null, previewPort: null },
            autoPublish: false,
          },
        },
    );
    setSettingsDirty(false);
    closePicker();
  };
  const start = async (message: string, attachments?: MediaAttachment[]) => {
    const value = snapshot();
    if (!value || sending.current) return;
    if (attachments?.length && !message.trim()) {
      setError("Add an instruction for the attached media before starting.");
      return;
    }
    if (settingsDirty) {
      setError("Save your source settings before starting.");
      return;
    }
    const parsed = SessionStartSchema.safeParse(
      value.pendingStart ?? {
        operationId: value.operationId,
        source: value.source ? { ...value.source, kind: "github" } : { kind: "template" },
        ...(message.trim() ? { prompt: { message, model: value.model, attachments } } : {}),
      },
    );
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message);
      return;
    }
    sending.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const pending = { ...value, pendingStart: parsed.data };
      setDraft(pending);
      await persist(pending);
      const response = await fetchJson(`${GITHUB_API_URL}/sessions/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500) {
          const editable = { ...value, pendingStart: undefined };
          setDraft(editable);
          await persist(editable);
        }
        const message =
          typeof body === "object" &&
          body !== null &&
          "error" in body &&
          typeof body.error === "string"
            ? body.error
            : "Could not start this session. Retry to recover the same request.";
        throw new Error(message);
      }
      const result = SessionStartedSchema.parse(body);
      await saveTail.current;
      await store.current.remove(ownerId, value.id);
      sessionStorage.removeItem(pointer);
      router.push(`/p/${result.projectId}`);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Could not finish starting the session. Your draft is saved when storage is available. Retry with this draft to recover the same session.",
      );
      sending.current = false;
      setBusy(false);
    }
  };
  const source = draft?.source;
  return (
    <DashboardHero
      value={draft?.text ?? ""}
      busy={busy || !draft || !!draft.pendingStart}
      error={error}
      models={models}
      modelsLoading={modelsLoading}
      model={draft?.model ?? fallback}
      onModelChange={(model) => setDraft((value) => value && { ...value, model })}
      onAddKey={onAddKey}
      mediaState={media}
      onChange={(text) => {
        // The mention is an input affordance, not part of the task sent to the model.
        if (text.endsWith("@repos:")) {
          setPicker(true);
          text = text.slice(0, -7);
        }
        setDraft((value) => value && { ...value, text });
      }}
      onSubmit={(message, attachments) => void start(message, attachments)}
      onRepositories={() => setPicker(true)}
      canOpenWorkspace={!!source}
      source={
        <>
          {draft?.pendingStart && (
            <p role="status">
              A start request is pending.{" "}
              <button
                type="button"
                disabled={busy}
                onClick={() => void start(draft.text, draft.attachments)}
              >
                Retry pending start
              </button>
            </p>
          )}
          {source && (
            <div className="composer-source">
              <span className="source-chip">
                <button
                  type="button"
                  disabled={busy || !!draft?.pendingStart}
                  onClick={() => setPicker(true)}
                  aria-label={`Switch repository, ${source.repository.fullName}`}
                >
                  {source.repository.fullName} ⌄
                </button>
                <button
                  type="button"
                  disabled={busy || !!draft?.pendingStart}
                  aria-label="Remove repository"
                  onClick={() => {
                    setDraft((value) => value && { ...value, source: null });
                    setSettingsDirty(false);
                  }}
                >
                  ×
                </button>
              </span>
              <details className="source-settings">
                <summary>Source settings</summary>
                <form
                  key={`${source.installationId}-${source.repositoryId}`}
                  aria-label="Source settings"
                  onChange={() => setSettingsDirty(true)}
                  onSubmit={(event) => {
                    event.preventDefault();
                    const fields = new FormData(event.currentTarget);
                    const parsed = RepositoryImportSchema.safeParse({
                      ...source,
                      baseBranch: fields.get("branch"),
                      autoPublish: fields.get("publish") === "on",
                      environment: {
                        setupCommand: fields.get("setup") || null,
                        devCommand: fields.get("dev") || null,
                        previewPort: fields.get("port") ? Number(fields.get("port")) : null,
                      },
                    });
                    if (!parsed.success) {
                      setError(parsed.error.issues[0]?.message);
                      return;
                    }
                    setDraft((value) =>
                      value?.source
                        ? {
                            ...value,
                            source: { ...parsed.data, repository: value.source.repository },
                          }
                        : value,
                    );
                    setSettingsDirty(false);
                    setError(undefined);
                    event.currentTarget.closest("details")?.removeAttribute("open");
                  }}
                >
                  <label>
                    Base branch
                    <input
                      name="branch"
                      defaultValue={source.baseBranch}
                      required
                      disabled={busy || !!draft?.pendingStart}
                    />
                  </label>
                  <label>
                    Setup command
                    <input
                      name="setup"
                      defaultValue={source.environment.setupCommand ?? ""}
                      placeholder="Optional, for example npm ci"
                      disabled={busy || !!draft?.pendingStart}
                    />
                  </label>
                  <label>
                    Development command
                    <input
                      name="dev"
                      defaultValue={source.environment.devCommand ?? ""}
                      placeholder="Optional preview"
                      disabled={busy || !!draft?.pendingStart}
                    />
                  </label>
                  <label>
                    Preview port
                    <input
                      name="port"
                      type="number"
                      min="1024"
                      max="65535"
                      defaultValue={source.environment.previewPort ?? ""}
                      disabled={busy || !!draft?.pendingStart}
                    />
                  </label>
                  <label className="source-publish">
                    <input
                      type="checkbox"
                      name="publish"
                      defaultChecked={source.autoPublish}
                      disabled={busy || !!draft?.pendingStart}
                    />{" "}
                    Publish verified changes as a draft PR
                  </label>
                  <button type="submit" disabled={busy || !!draft?.pendingStart}>
                    Save source settings
                  </button>
                </form>
              </details>
              {!draft?.text.trim() && !media.attachments.length && (
                <span className="source-open-hint">
                  Open workspace without starting a model task
                </span>
              )}
            </div>
          )}
        </>
      }
      picker={
        picker && (
          <RepositoryPicker
            fetchJson={fetchJson}
            selected={source ?? undefined}
            onSelect={select}
            onClose={closePicker}
            onConnect={() => void connect()}
          />
        )
      }
    />
  );
}
