# ADR-0015 — Media references travel with the prompt

**Status:** Accepted — 2026-10-19

## Context

A reference must survive the same boundaries as its prompt: admission, a queued worker,
event replay, and retry after a failed turn. Browser object URLs expire with the page and cannot
serve as durable references. Uploading originals to an object store would add a separate lifetime,
authorization boundary and cleanup mechanism for a feature that only sends prepared images.

## Decision

The browser prepares JPEG frames and sends them inline with the prompt. The queue stores the
attachments, and `user.message` carries the same bytes into the event log. Retry reuses those
frames; it does not decode the original again. Original files stay in the browser. Video is
three sampled frames with timestamps and duration, without audio; a GIF supplies one image.

Preparation accepts images up to 10 MiB and videos up to 50 MiB and 120 seconds. It scales the
longest output side to at most 1280 pixels, fills transparency white, and encodes JPEG at quality
0.8. Video samples are at 5%, 50% and 95% of its duration. Each video load or seek has a 15-second
deadline. The shared schema admits at most four attachments and 3,000,000 base64 characters in
total. It validates the transport shape, count and size, not whether the bytes are a valid JPEG.

Image input is allowed only for exact model IDs in `@nap/shared/model-capabilities`. The initial
set is OpenAI GPT 5.6 Luna, Terra and Sol, and Anthropic Claude Sonnet 5 and Opus 5. Their
OpenRouter pages list image input: [Luna](https://openrouter.ai/openai/gpt-5.6-luna),
[Terra](https://openrouter.ai/openai/gpt-5.6-terra),
[Sol](https://openrouter.ai/openai/gpt-5.6-sol),
[Sonnet](https://openrouter.ai/anthropic/claude-sonnet-5), and
[Opus](https://openrouter.ai/anthropic/claude-opus-5), checked on 2026-10-19.
Missing and unknown IDs are text-only until verified and added. Model names or provider prefixes
are insufficient evidence. This policy is bundled with the client and server; it is not a live
provider capability lookup and must be maintained when the allowlist changes.

The composer keeps references when the selected model cannot use them and explains how to
resolve the choice. Admission refuses new references before spending rate allowance or queuing
work. The runtime passes the effective model to context assembly. Historical attachments become
named omission markers for text-only models, preserving the original message and stored frames.
Switching back to an image model restores those frames in context. Current references are never
silently omitted. Historical frames follow whole-turn eviction in the existing budget ladder;
current media stays with the current prompt and an oversized current request is refused.

## Consequences and rollout

There is no new `/models` field. Its strict schema remains compatible between old and new model
list readers; a new client can use the old response and treats unfamiliar model IDs conservatively.
Old clients do not gain the new composer guard until refreshed, so the updated API remains the
admission authority. The shared policy also protects context assembly for internal callers.

The media feature itself changes event payloads and adds the queue's attachments column. Deploy
the additive database migration and media-aware queue/event readers and workers before enabling
media producers. Old strict event clients need a refresh before they consume events with the new
field. A web-only release against old workers is not a supported rollout: old code can discard
fields it does not know. This ordering is a deployment requirement, not evidence that a mixed
deployment has been exercised.

Prepared frames persist with queue rows and events. Deleting a project cascades through its
sessions to both tables. They can also occur in database backups and exported event logs; this
change adds no separate retention policy. Inline media increases database, replay, and context
traffic; the per-request limit is not a system capacity measurement.

The input byte limits and smaller output canvas do **not** bound native decoder memory before
scaling. A small compressed input may describe a large decoded image or video frame. Preparation
is serial and video resources are released, but dimension preflight is not implemented. Tests
cover safe small files and boundary failures; they do not establish an exhaustion limit. A future
change needing such a guarantee must choose a decoding boundary that can enforce it.
