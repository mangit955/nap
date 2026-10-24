"use client";

/**
 * Settings → Providers: every way a turn can be paid for, listed beside an editor for the one
 * selected. T3 Code's provider settings, in Nap's palette.
 *
 * The list holds Nap's two built-in ways to run — the free models and an API key — above the
 * Claude and ChatGPT accounts somebody connected. The built-ins have no switch: there is nothing
 * to turn off about the free models, and an API key is removed rather than disabled. Connected
 * accounts have T3's switch, which keeps an account and its login but stops new turns using it.
 *
 * Below `48rem` of its own width the list stacks above the editor instead of beside it, as T3's
 * does; that is a container query, so it follows the page's width rather than the window's.
 *
 * Adapted from T3 Code (MIT); see `THIRD_PARTY_NOTICES.md`.
 */

import type { ProviderAccountView } from "@nap/shared/provider-accounts-protocol";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ApiKeyPanel } from "../account/api-key-panel.tsx";
import { useApiKey } from "../account/use-api-key.ts";
import { NapMark } from "../brand/nap-mark.tsx";
import { relativeTime } from "../dashboard/relative-time.ts";
import type { FetchJson } from "../files/use-project-files.ts";
import { SettingsShell } from "../settings/settings-shell.tsx";
import { KeyIcon, PlusIcon, ReloadIcon, TrashIcon } from "../ui/icons.tsx";
import { Switch } from "../ui/switch.tsx";
import { AccountSignIn } from "./account-sign-in.tsx";
import { accountStatus, TONE_DOT } from "./account-status.ts";
import { AddProviderDialog } from "./add-provider-dialog.tsx";
import { accountName, DRIVERS } from "./drivers.tsx";
import {
  GHOST_BUTTON,
  ICON_BUTTON,
  INPUT,
  OUTLINE_BUTTON,
  ProviderRow,
  ProviderSection,
} from "./provider-settings-ui.tsx";
import { type ProviderAccountsApi, useProviderAccounts } from "./use-provider-accounts.ts";

type Selection = "free" | "api-key" | string;

export function ProvidersPage({
  fetchJson,
  baseUrl,
  confirm,
}: {
  fetchJson?: FetchJson;
  baseUrl?: string;
  confirm?: (message: string) => boolean;
}) {
  const api = useProviderAccounts({
    ...(fetchJson === undefined ? {} : { fetchJson }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
  });
  const key = useApiKey({
    ...(fetchJson === undefined ? {} : { fetchJson }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
  });
  const [keyOpen, setKeyOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [signInErrors, setSignInErrors] = useState<Record<string, string | null>>({});
  const [selected, setSelected] = useState<Selection | null>(null);

  const loaded = api.state.kind === "loaded" ? api.state.value : null;
  const accounts = loaded?.accounts ?? [];
  // The first connected account until somebody picks one, and the free models when there is none
  // — a selection that names a removed account falls back the same way.
  const selection: Selection =
    selected === "free" ||
    selected === "api-key" ||
    accounts.some((account) => account.id === selected)
      ? (selected ?? "free")
      : (accounts[0]?.id ?? "free");
  const selectedAccount = accounts.find((account) => account.id === selection);

  return (
    <SettingsShell
      crumbs={[{ label: "Settings" }, { label: "Providers" }]}
      activePage="providers"
      onApiKey={() => setKeyOpen(true)}
    >
      <div className="@container/providers mx-auto max-w-[60rem]">
        <ProviderSection
          level={1}
          title="Providers"
          titleAction={
            <button
              type="button"
              disabled={loaded === null}
              aria-label="Add provider"
              title="Add provider"
              className={ICON_BUTTON}
              onClick={() => setAdding(true)}
            >
              <PlusIcon className="size-3.5" />
            </button>
          }
          headerAction={
            <button
              type="button"
              disabled={api.refreshing || loaded === null}
              aria-busy={api.refreshing}
              title="Refresh provider status"
              className={`${GHOST_BUTTON} h-6 px-2 text-xs font-normal`}
              onClick={() => void api.refresh()}
            >
              <ReloadIcon className={`size-3.5 ${api.refreshing ? "animate-spin" : ""}`} />
              <span className="sr-only">Refresh provider status</span>
              <span aria-hidden="true" className="hidden min-w-0 truncate sm:inline">
                {api.refreshing
                  ? "Refreshing providers"
                  : loaded
                    ? `Checked ${relativeTime(loaded.checkedAt)}`
                    : null}
              </span>
            </button>
          }
        >
          {api.state.kind === "loading" ? (
            <p role="status" className="p-6 text-sm text-muted">
              Loading providers…
            </p>
          ) : api.state.kind === "failed" ? (
            <div role="alert" className="flex flex-wrap items-center gap-3 p-6 text-sm">
              <span className="text-danger">{api.state.error}</span>
              <button type="button" className={OUTLINE_BUTTON} onClick={() => void api.refresh()}>
                Try again
              </button>
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl @min-[48rem]/providers:grid @min-[48rem]/providers:h-[min(44rem,calc(100dvh-9rem))] @min-[48rem]/providers:grid-cols-[17rem_minmax(0,1fr)]">
              <nav
                aria-label="Providers"
                className="border-edge border-b bg-field/40 @min-[48rem]/providers:min-h-0 @min-[48rem]/providers:overflow-y-auto @min-[48rem]/providers:border-r @min-[48rem]/providers:border-b-0"
              >
                <ul className="divide-y divide-edge">
                  <li>
                    <ListRow
                      name="Free models"
                      icon={<NapMark className="size-[18px]" />}
                      status="Included with nap"
                      selected={selection === "free"}
                      onSelect={() => setSelected("free")}
                    />
                  </li>
                  <li>
                    <ListRow
                      name="API key"
                      icon={<KeyIcon className="size-4" />}
                      version={key.state?.configured ? key.state.platform : undefined}
                      status={
                        key.state?.configured
                          ? `Connected · ${key.state.hint}`
                          : key.loaded
                            ? "Not connected"
                            : "Checking…"
                      }
                      selected={selection === "api-key"}
                      onSelect={() => setSelected("api-key")}
                    />
                  </li>
                  {accounts.map((account) => (
                    <li key={account.id}>
                      <AccountListRow
                        account={account}
                        selected={selection === account.id}
                        onSelect={() => setSelected(account.id)}
                        onEnabled={(enabled) => api.update(account.id, { enabled })}
                      />
                    </li>
                  ))}
                  <li>
                    <button
                      type="button"
                      className="flex w-full cursor-pointer items-center gap-3 px-3 py-3 text-left text-sm text-muted transition-colors outline-none hover:bg-row-hover hover:text-ink focus-visible:bg-row-hover focus-visible:text-ink sm:px-4"
                      onClick={() => setAdding(true)}
                    >
                      <PlusIcon className="size-4 shrink-0" />
                      Add provider
                    </button>
                  </li>
                </ul>
              </nav>

              <div className="min-w-0 @min-[48rem]/providers:min-h-0 @min-[48rem]/providers:overflow-y-auto">
                <div className="space-y-6 p-4">
                  {selectedAccount && loaded ? (
                    <AccountEditor
                      key={selectedAccount.id}
                      account={selectedAccount}
                      signInAvailable={loaded.signInAvailable}
                      api={api}
                      startError={signInErrors[selectedAccount.id] ?? null}
                      onStartSignIn={() => {
                        setSignInErrors((previous) => ({
                          ...previous,
                          [selectedAccount.id]: null,
                        }));
                        return api.startSignIn(selectedAccount.id);
                      }}
                      {...(confirm === undefined ? {} : { confirm })}
                    />
                  ) : selection === "api-key" ? (
                    <BuiltInEditor
                      title="API key"
                      icon={<KeyIcon className="size-4" />}
                      rowTitle={key.state?.configured ? "Connected" : "Not connected"}
                      description={
                        key.state?.configured
                          ? `Your requests use your own ${key.state.platform === "anthropic" ? "Anthropic" : "OpenRouter"} key, ${key.state.hint}.`
                          : "Bring your own OpenRouter or Anthropic key to unlock the paid models."
                      }
                      control={
                        <button
                          type="button"
                          className={OUTLINE_BUTTON}
                          onClick={() => setKeyOpen(true)}
                        >
                          {key.state?.configured ? "Manage key" : "Add key"}
                        </button>
                      }
                    />
                  ) : (
                    <BuiltInEditor
                      title="Free models"
                      icon={<NapMark className="size-[18px]" />}
                      rowTitle="Included with nap"
                      description="Start a project on the free model without connecting anything. Turns on it count against the free allowance."
                    />
                  )}
                </div>
              </div>
            </div>
          )}
        </ProviderSection>
      </div>

      <ApiKeyPanel open={keyOpen} onClose={() => setKeyOpen(false)} keyState={key} />
      {loaded ? (
        <AddProviderDialog
          open={adding}
          onClose={() => setAdding(false)}
          signInAvailable={loaded.signInAvailable}
          onCreate={api.create}
          onStartSignIn={api.startSignIn}
          onCreated={(id, startError) => {
            setSelected(id);
            setSignInErrors((previous) => ({ ...previous, [id]: startError }));
          }}
        />
      ) : null}
    </SettingsShell>
  );
}

/** One entry in the list: icon, name, a one-line status, and on the right whatever it controls. */
function ListRow({
  name,
  icon,
  version,
  status,
  dot,
  dimmed = false,
  selected,
  onSelect,
  trailing,
}: {
  name: string;
  icon: ReactNode;
  version?: string | undefined;
  status: string;
  dot?: string | null;
  dimmed?: boolean;
  selected: boolean;
  onSelect: () => void;
  trailing?: ReactNode;
}) {
  return (
    <div
      className={`group flex min-h-18 items-center gap-3 px-3 py-3 transition-colors sm:px-4 ${selected ? "bg-row-active" : "hover:bg-row-hover"}`}
    >
      <div
        className={`pointer-events-none relative flex min-w-0 flex-1 items-start gap-3 rounded-md text-left transition-opacity ${dimmed && !selected ? "opacity-60 group-hover:opacity-100" : ""}`}
      >
        {/*
          The whole row selects, but the switch beside it must stay its own control — so the
          select button covers the row's text and icon only, as T3's does.
        */}
        <button
          type="button"
          className="pointer-events-auto absolute inset-0 cursor-pointer rounded-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
          onClick={onSelect}
          aria-label={`Select ${name}`}
          aria-pressed={selected}
        />
        <span className="flex size-5 shrink-0 items-center justify-center text-ink/80">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium text-ink">{name}</span>
            {version ? (
              <code className="max-w-24 shrink-0 truncate text-xs text-muted">{version}</code>
            ) : null}
          </span>
          <span className="mt-0.5 flex items-start gap-1.5 text-xs leading-normal text-muted">
            {dot ? (
              <span className="flex h-[1.45em] shrink-0 items-center">
                <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${dot}`} />
              </span>
            ) : null}
            <span className="line-clamp-2 [overflow-wrap:anywhere]">{status}</span>
          </span>
        </span>
      </div>
      {trailing ? <span className="flex h-5 shrink-0 items-center gap-1">{trailing}</span> : null}
    </div>
  );
}

function AccountListRow({
  account,
  selected,
  onSelect,
  onEnabled,
}: {
  account: ProviderAccountView;
  selected: boolean;
  onSelect: () => void;
  onEnabled: (enabled: boolean) => ReturnType<ProviderAccountsApi["update"]>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const driver = DRIVERS[account.driver];
  const status = accountStatus(account);
  const name = accountName(account);
  return (
    <ListRow
      name={name}
      icon={driver.icon("size-4")}
      // Unnamed Codex accounts are called "Codex", the same as their runtime; saying it twice
      // says nothing.
      version={driver.runtime === name ? undefined : driver.runtime}
      status={status.headline}
      dot={TONE_DOT[status.tone]}
      dimmed={!account.enabled}
      selected={selected}
      onSelect={onSelect}
      trailing={
        <span className="flex flex-col items-end gap-1">
          <Switch
            checked={account.enabled}
            disabled={pending}
            onChange={async (enabled) => {
              setPending(true);
              const result = await onEnabled(enabled);
              setError(result.ok ? null : result.error);
              setPending(false);
            }}
            label={`Enable ${name}`}
          />
          {error ? (
            <span role="alert" className="text-xs text-danger">
              {error}
            </span>
          ) : null}
        </span>
      }
    />
  );
}

function AccountEditor({
  account,
  signInAvailable,
  api,
  onStartSignIn,
  startError,
  confirm = (message) => window.confirm(message),
}: {
  account: ProviderAccountView;
  signInAvailable: boolean;
  api: ProviderAccountsApi;
  onStartSignIn: () => ReturnType<ProviderAccountsApi["startSignIn"]>;
  startError: string | null;
  confirm?: (message: string) => boolean;
}) {
  const driver = DRIVERS[account.driver];
  const name = accountName(account);
  const status = accountStatus(account);
  const reverting = useRef(false);
  const dirty = useRef(false);
  const editVersion = useRef(0);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [draft, setDraft] = useState(account.label ?? "");
  const [error, setError] = useState<string | null>(null);

  // Refreshes replace clean labels; a save only acknowledges the draft it was sent for.
  useEffect(() => {
    if (!dirty.current) setDraft(account.label ?? "");
  }, [account.label]);

  async function commitLabel() {
    const next = draft.trim() === "" ? null : draft.trim();
    if (next === account.label) {
      dirty.current = false;
      setDraft(next ?? "");
      return;
    }
    const version = editVersion.current;
    const result = await api.update(account.id, { label: next });
    if (result.ok && editVersion.current === version) {
      dirty.current = false;
      setDraft(result.value.label ?? "");
    }
    setError(result.ok ? null : result.error);
  }

  const signedIn = account.auth.status === "authenticated";

  return (
    <>
      <ProviderSection
        title={name}
        level={2}
        icon={
          <span className="flex size-5 items-center justify-center">
            {driver.icon("size-4 text-ink/80")}
          </span>
        }
        headerAction={
          <div className="flex shrink-0 items-center gap-1.5">
            {driver.runtime === name ? null : (
              <code className="text-xs text-muted">{driver.runtime}</code>
            )}
            <button
              type="button"
              aria-label={`Delete ${name}`}
              title={`Delete ${name}`}
              className={`${ICON_BUTTON} hover:text-danger`}
              onClick={async () => {
                if (
                  confirm(
                    `Delete ${name}? Nap forgets this account and signs its agent out. Session history is kept.`,
                  )
                ) {
                  const result = await api.remove(account.id);
                  setDeleteError(result.ok ? null : result.error);
                }
              }}
            >
              <TrashIcon className="size-3.5" />
            </button>
            {deleteError ? (
              <p role="alert" className="text-xs text-danger">
                {deleteError}
              </p>
            ) : null}
          </div>
        }
      >
        <ProviderRow
          title={<label htmlFor={`label-${account.id}`}>Display name</label>}
          status={
            <>
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
                {signedIn && account.auth.email ? (
                  <>
                    <span>Authenticated as</span>
                    <span className="max-w-full truncate text-ink-2">{account.auth.email}</span>
                    {account.auth.plan ? <span>· {account.auth.plan}</span> : null}
                  </>
                ) : (
                  <>
                    {TONE_DOT[status.tone] ? (
                      <span
                        aria-hidden="true"
                        className={`size-1.5 shrink-0 self-center rounded-full ${TONE_DOT[status.tone]}`}
                      />
                    ) : null}
                    <span>{status.headline}</span>
                  </>
                )}
              </div>
              {error ? (
                <p role="alert" className="pt-1 text-danger">
                  {error}
                </p>
              ) : null}
            </>
          }
          control={
            <input
              id={`label-${account.id}`}
              className={`${INPUT} w-full flex-1 @min-[32rem]/settings-row:w-56`}
              value={draft}
              placeholder={driver.name}
              maxLength={40}
              spellCheck={false}
              onChange={(event) => {
                dirty.current = true;
                editVersion.current += 1;
                setDraft(event.target.value);
              }}
              onBlur={() => {
                if (reverting.current) {
                  reverting.current = false;
                  return;
                }
                void commitLabel();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  // blur dispatches before React renders the restored draft.
                  reverting.current = true;
                  dirty.current = false;
                  editVersion.current += 1;
                  setDraft(account.label ?? "");
                  event.currentTarget.blur();
                }
              }}
            />
          }
        />
      </ProviderSection>

      <ProviderSection title="Setup">
        <AccountSignIn
          account={account}
          signInAvailable={signInAvailable}
          onStart={onStartSignIn}
          onCancel={() => api.cancelSignIn(account.id)}
          onSignOut={() => api.signOut(account.id)}
          confirm={confirm}
          startError={startError}
        />
      </ProviderSection>

      <ProviderSection title="Runtime">
        <ProviderRow
          title={driver.runtime}
          description={
            signInAvailable
              ? `This account is for ${driver.runtime}. Adding it doesn't start an agent.`
              : `${driver.runtime} runtime and sign-in aren't available on this deployment yet.`
          }
        />
      </ProviderSection>
    </>
  );
}

function BuiltInEditor({
  title,
  icon,
  rowTitle,
  description,
  control,
}: {
  title: string;
  icon: ReactNode;
  rowTitle: string;
  description: string;
  control?: ReactNode;
}) {
  return (
    <ProviderSection
      title={title}
      level={2}
      icon={<span className="flex size-5 items-center justify-center text-ink/80">{icon}</span>}
    >
      <ProviderRow title={rowTitle} description={description} control={control} />
    </ProviderSection>
  );
}
