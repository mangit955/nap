# E2B native process probe, 2026-10-24

The user separately approved two one-sandbox probes, each with a maximum lifetime of 60 seconds
and destruction afterward. Both approvals covered process containment and detached-child
cancellation. Neither covered subscription authentication, model calls or template publication.
The first run was inconclusive; the second passed. No third allocation ran.

## First run, before the repair

The prepared probe ran once against E2B using the existing privately configured API key. The
sandbox was created with a 60-second timeout, but the old adapter then called `Sandbox.connect()`
without timeout options. The installed E2B SDK requests a five-minute timeout by default and can
extend a running sandbox, so that call did not preserve the requested server-side backstop.
This SDK behavior was missed before the run.

Cleanup awaited `sandbox.kill()` in `finally` and returned without an error. The local run log's
creation-to-final-error timestamps span about 4.4 seconds, including sandbox destruction, so the
actual run stayed inside the approved 60 seconds. No other allocation ran under that first
approval, and there was no real authentication or model call.

The probe reached and passed its strict privilege-result parser before requesting cancellation:

- The child reported UID 1000 and `NoNewPrivs: 1`.
- The sudo attempt did not succeed.
- Moving the detached child into the parent cgroup was refused.

Cancellation then failed the transport's termination check with:

```text
Complete process termination was not confirmed.
```

This is an incomplete containment proof. The detached-child `/proc` inspection occurs after the
termination receipt check and did not run. The result does not establish whether that child
survived the cgroup cancellation. Destroying the sandbox afterward is a separate cleanup action.
PTY behavior, reconnect and credential isolation were not part of this live result.

The original probe printed neither the terminal receipt nor its error code. It therefore cannot
distinguish a missing receipt from a receipt reporting unknown containment. The SDK stream and
sandbox are closed; those details cannot be recovered from the recorded output.

## Local repair

A deterministic SDK fixture reproduced an independent transport race: output is persisted, its
ACK RPC fails as the process closes stdin, and a valid exit receipt is queued or arrives next.
The old adapter marked the stream failed before processing that receipt. This could explain the
live failure, but the probe's original diagnostic is insufficient to establish that cause.

The adapter now fences further input and lease renewal on command uncertainty, requests stop,
and retains the stream for a bounded terminal-receipt window. A valid receipt must still follow
the complete, durably accepted sequence. Missing receipts remain failures, and unknown containment
is never upgraded. Tests cover queued and later receipts, SDK completion before the receipt,
unknown containment, and expiry without proof. They use no E2B allocation.

The adapter now requires an explicitly attached sandbox client. It can run or reconnect commands
through that existing handle, without calling `Sandbox.connect()` or requesting VM lifetime
changes. A local fixture checks the attached sandbox ID and command calls. The
probe supplies its originally created handle, preserving the original timeout.

The probe now prints sanitized lifecycle, stop-result, termination and detached-child metadata,
then cleanup status. It inspects the detached child even if the receipt is uncertain, but still
requires the cgroup receipt to pass. Overall success is printed only after cleanup.

## Second run, separately approved verification

The user approved one additional 60-second sandbox using commit `ed611bc`. The probe rebuilt
that supervisor and used the attached sandbox handle. It finished at
`2026-10-24T07:32:54Z`. Local log timestamps span about 4.95 seconds from invocation through
successful cleanup. The deployed bundle's SHA-256 was:

```text
a8cdcc5d49fa6cee8421588e36a2b5e49d7b7979603810f445a00fe95600a959
```

The live result was:

| Check | Result |
|---|---|
| Child UID | 1000 |
| No-new-privileges | Enabled |
| Sudo attempt | Refused |
| Parent-cgroup escape attempt | Refused |
| Stop command | Confirmed |
| Terminal receipt | `reason: stopped`, `containment: cgroup`, `code: null` |
| Detached child | Stopped, confirmed by the `/proc` inspection |
| Sandbox destruction | `killed: true` |
| Overall probe | `passed: true` |

The detached-child inspection accepts a missing process or a zombie that can no longer execute.
The cgroup receipt additionally requires the kernel to report the whole group empty. Success
does not depend on the deliberately stopped native process returning exit code zero.

This verifies the cancellation case on one fresh E2B base sandbox. It does not establish the
cause of the first run's failure. Live PTY behavior, reconnect, worker-loss expiry, durable event
recovery, credential isolation and provider authentication remain separate checks. No subscription
provider is enabled by this result. Both one-sandbox allowances have been consumed; any further
paid allocation requires fresh approval.
