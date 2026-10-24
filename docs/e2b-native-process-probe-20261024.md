# E2B native process probe, 2026-10-24

The user approved one paid sandbox with a maximum lifetime of 60 seconds, process-containment
and detached-child cancellation checks, and destruction afterward. Subscription authentication,
model calls, template publication and another allocation were outside that approval.

## Observed result

The prepared probe ran once against E2B using the existing privately configured API key. The
sandbox was created with a 60-second timeout, but the old adapter then called `Sandbox.connect()`
without timeout options. The installed E2B SDK requests a five-minute timeout by default and can
extend a running sandbox, so that call did not preserve the requested server-side backstop.
This SDK behavior was missed before the run.

Cleanup awaited `sandbox.kill()` in `finally` and returned without an error. The local run log's
creation-to-final-error timestamps span about 4.4 seconds, including sandbox destruction, so the
actual run stayed inside the approved 60 seconds. No second allocation or real authentication/model
call ran.

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

## Local repair and remaining verification

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
probe supplies its originally created handle, preserving the original timeout for a future run.

The probe now prints sanitized lifecycle, stop-result, termination and detached-child metadata,
then cleanup status. A future run inspects the detached child even if the receipt is uncertain,
but still requires the cgroup receipt to pass. Overall success is printed only after cleanup. That diagnostic change has only been checked offline. Another live run requires new
approval; the earlier one-sandbox allowance has been consumed. Production subscription execution
remains disabled pending the live termination proof and the separate credential-boundary proof.
