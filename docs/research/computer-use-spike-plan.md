# Paid computer-use spike: proposed scope

Status: awaiting explicit spending approval in this thread. No template build, real sandbox, model inference or OpenRouter inference request has run for this work.

This is the execution scope for [the spike](https://github.com/mangit955/nap/issues/138), before finalizing ADR-0018 or building the production desktop template. It does not authorize a subscription upgrade, a production-template replacement, a branch push or a PR.

## What the spend establishes

1. Layer a throwaway desktop template on the existing Nap project template, with Xvfb at 1024×768, a small window manager, Chrome, xdotool, ffmpeg and the VNC/websocket stack. Publish only new spike names. Keep the dev server running and start the desktop lazily.
2. Try the pinned SDK's current 2-vCPU/1-GiB default first. Record effective provider resources, VM cold start, desktop-ready latency, Chrome plus Vite memory and OOM behavior. If needed and available on the existing account plan, compare 4 GiB. No plan upgrade.
3. Capture five 1024×768 JPEGs and record elapsed time and byte size, with one input action followed by a new frame. Use only a fresh synthetic app, never the user's Devin account or project data.
4. Send one short image-inside-`tool_result` probe to each of `anthropic/claude-sonnet-5` and `anthropic/claude-opus-5` through the Anthropic-shaped OpenRouter endpoint used by Nap. Force a structured report of an image-only probe marker, so accepting the request is distinguished from reading the image. Do not assert on model prose. Cap output at 512 tokens, disable reasoning, and use no automatic retries.
5. Record template/build IDs, effective resources, timings, memory, image sizes, provider usage and structured tool payloads. Kill every created sandbox in cleanup. Delete only the throwaway artifacts created by the spike. Record findings in GOTCHAS and the spike issue before making production sizing decisions.

Bounded scope: at most two throwaway template configurations, one sandbox per configuration with a ten-minute lifetime, five captures per configuration, and one inference request per model. Target a twenty-minute build window per configuration. Monitor builds rather than treating a local request timeout as proof that remote work ended. Stop before additional experiments if the remaining approved budget is insufficient.

## Cost basis and requested budget

Proposed authorization: **up to US$1 in usage**, using existing accounts and credentials. Expected usage under these bounds is approximately **US$0.30**, before any account-specific discounts or charges. This is an estimate, not a provider quote.

Official rates checked on 2026-10-24:

- [E2B pricing](https://e2b.dev/pricing): 2 vCPUs cost $0.000028/s; 1 GiB costs $0.0000045/s and 4 GiB costs $0.000018/s. That is about $0.00195/min for 2 vCPU/1 GiB and $0.00276/min for 2 vCPU/4 GiB. Budgeting thirty compute minutes for each configuration gives approximately $0.1413. Build billing needs confirmation from the account's measured usage; this estimate reserves compute for both build and run time.
- [Sonnet 5 on OpenRouter](https://openrouter.ai/anthropic/claude-sonnet-5): $2/M input and $10/M output tokens. A conservative 20,000 input tokens plus 512 output tokens is about $0.04512.
- [Opus 5 on OpenRouter](https://openrouter.ai/anthropic/claude-opus-5): $5/M input and $25/M output tokens. The same allowance is about $0.1128.

The pinned E2B 2.38 types say the template default is 1024 MB, while the current pricing page labels 4 GiB as the default. The spike must record the actual resources instead of assuming those statements describe the same template. If the account requires an upgrade or cannot create a requested size, stop and report it.

Approval of this scope does not approve the production template build. That step will have its own reviewed template and permission request after the measurements. Until approval, continue using the fake desktop and scripted model tests described in [the implementation notes](../computer-use.md).
