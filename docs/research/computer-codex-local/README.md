# Local computer testing with a Codex subscription

The local launcher can use an existing ChatGPT Codex subscription for Nap's model decisions. The real run caught the planted Save bug and repaired it through **Fix it**. Its retest saved a second note but failed an expectation of exactly one. A separate free owner-input check saved a complete note and retained control across three natural recovery-pending polls. Those outcomes are preserved separately.

## Run locally

Use Docker, Node, Bun and installed workspace dependencies. The checked macOS setup used Codex CLI 0.164.0 at `/opt/homebrew/bin/codex`, Node 26.12.0 and Bun 1.4.2. The adapter currently invokes that Homebrew path and requires the normal managed ChatGPT login from the user's home directory.

```sh
/opt/homebrew/bin/codex login status
bun run computer:local --codex
```

If needed, sign in through `/opt/homebrew/bin/codex login`. API-key authentication is refused. The optional explicit model is:

```sh
bun run computer:local --codex --model=gpt-5.6-sol
```

The native model maps honestly to Nap's `openai/gpt-5.6-sol`. The launcher prints the local workspace and demo login, using UI 3047 / API 3048. Occupied ports cause startup to fail.

A scripted seed creates the deliberately buggy Notes app. After that succeeds, **Test the app**, explicit **Fix it**, and subsequent interactive turns use Codex through Nap's AgentService, with real JPEG observations and Nap-owned tools. The fixture's visible scripted-demo badge describes its seed. Test failure never starts a repair automatically.

`bun run computer:local` keeps the default scripted mode with no model inference. Codex mode consumes the existing plan allowance. These local runs used no OpenRouter, API-key model fallback or E2B. Production model and sandbox paths retain their existing API/E2B configuration.

Objects and recordings are RAM-only; the database and sandbox are throwaway. Download recordings before stopping. Ctrl-C requests cleanup of owned workers, Codex children, containers, bridges and the isolated web copy. Docker image caches may remain. Both recorded runs confirmed owned cleanup.

## Observed results

The [curated summary](summary.json) records source hashes, usage and asset provenance. Final owner code was local snapshot `39447320dddb122038346c5f26bae81da4bf0e25`, tree `44289b07172cdff207b3b9345468089f8d892de9`. Earlier subscribed runs used adapter snapshot `ce32310c35a87bb149008fb13d15bc65f2d11ce1`, tree `db366d31e46c8490e302f4c2aa6f565a73ba6144`; its five files were unchanged in the final code.

- 83 focused cases, typecheck and lint passed. Eight guard mutations caught their intended failures with passing controls and exact restoration. Separate source reviews accepted the adapter and owner-poll repairs. Full new-tree suite/build gates were not run for this evidence checkpoint.
- One subscribed exec read a nonce supplied only in [JPEG pixels](vision.jpg), selecting the matching Nap type action. No action executed. Usage was 16,299 input / 48 output tokens.
- The initial subscribed test correctly failed Save, 0 passed / 1 failed. Explicit Fix it repaired and committed source, then physically demonstrated 1 saved note. Retest saved another note and remained 0 passed / 1 failed because it expected 1 and observed 2. No reset, prompt change or forced verdict replaced that result. Cycle usage was 313,576 input / 2,351 output tokens.
- Both real recordings passed playback, decoded seeking, HTTP range and byte-identical download checks. The [initial decoded frame](initial-recording-seek.png) is a still from the actual recording; video files are not included here.
- The separate free owner check typed and saved one 48-character note through the real UI in 17.056s. Control survived three unmodified 503 recovery_pending polls, then released normally. The [saved UI](owner-saved.png) and independent physical DOM check agreed on one complete row and a cleared input. This used scripted preparation and no model calls. The earlier owner timeout remains a separate unsuccessful observation.

Codex uses a private cwd, read-only sandbox and known tool/integration disables. Residual host reads remain possible. CLI child close proves local process closure only; Nap's physical input drain protocol remains separate. Bounded compaction is unsupported, and its warnings remain in the subscribed run.

This evidence is scoped to #181. #149, #155, matching UI-reference acceptance and E2B/template/cloud acceptance remain open. A clean-state passing subscribed retest and cloud readiness are not claimed.
