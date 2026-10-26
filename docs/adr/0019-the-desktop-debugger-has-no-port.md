# ADR-0019 — The desktop debugger has no port

**Status:** Accepted, 2026-10-26. Verified locally against Chrome 156 in the local desktop image and in a Linux replica. One real E2B VM on template build `3814bf7e-565e-43c2-883a-fc6898eb6657` passed desktop startup, the owner stream route, protocol 2, same-port reuse and 1024×768 screenshot capture, with no TCP debugging listener. A second VM on the same build, on the same day, passed live VNC viewing through the cloud proxy, owner input that saved a note in the app, a recording served by byte range that played and seeked, a scope-drain proof and a changed-port replacement. It ran without a model, the deployed runtime or real object storage. Its screens showed Chrome's warning bar for `--no-sandbox`; `--test-type` now hides it, so the next published build has not yet been seen on a VM.

## Context

The desktop's browser exposed the Chrome DevTools Protocol on `127.0.0.1:9222`, and three things used it: the startup script's readiness check, its ownership check, and the driver's read-only DOM and console observations (ADR-0018).

Four real E2B desktops then failed to start, each answering the owner's stream with `503 desktop_unavailable`. The same script started locally and in a replica built from the template's own `e2bdev/base` image. A diagnostic run kept the script's failure line, "Port 9222 is not owned by this desktop.", and showed why: port 9222 had two listening sockets. Chrome, the recorded owner, held one. No process visible to the desktop user held the other. This is consistent with envd forwarding, but the second listener's process identity and the precise forwarding mechanism remain inferred. Sandbox URLs are public by default (`allowPublicTraffic`). DevTools is full control of the browser: navigation past the URL policy, page JavaScript, cookies. Whether DevTools was reachable from the internet was never measured, and the ownership check refused to start beside the foreign listener. The check was right to.

Time-bounded startup waits were tried first, on the theory that a slow cold VM was missing a fixed attempt count. They are sound and stay, but they did not fix this ([GOTCHAS](../GOTCHAS.md#sandbox-and-storage)).

## Decision

**Chrome has no TCP debugging port.** It is launched with `--remote-debugging-pipe` and speaks CDP over descriptors 3 and 4, one JSON message per NUL-terminated frame — the same contract Puppeteer and Playwright launch it with. Its only debugging client is a small bridge, and the bridge's only endpoint is a Unix socket, `/home/user/.nap-desktop/cdp.sock`, created owner-only (`0600`, under a restrictive umask so no window exists) inside the desktop's `0700` state directory. This removes the TCP debugging channel without depending on the foreign listener's identity or forwarding mechanism. Chrome itself cannot serve DevTools on a Unix socket, which is why a bridge exists at all.

**The bridge is a mode of the driver bundle the image already ships**, so no new artifact is built, hashed or copied: `node driver.mjs --cdp-bridge <socket> -- <browser command…>` and `node driver.mjs --cdp-probe <socket>`. The logic lives in `packages/sandbox/src/desktop-cdp-bridge.ts`.

- It refuses to take over a socket path that answers, and refuses a path that is not a socket. It replaces a stale socket only when nothing is listening on it.
- Chrome holds one debugging connection, the pipe, whatever number of desktop processes ask it something. The bridge therefore rewrites request ids so concurrent clients' replies cannot cross, gives each flat session to the client that attached it, delivers a session's events only to that client, and detaches whatever a client left attached when its connection ends, however it ends. A start-time readiness probe and an observation can run at once without either waiting on the other.
- Frames are bounded both ways, and only complete frames are ever passed on. Connections beyond a small limit are refused.
- Its lifetime is the browser's, in both directions. When Chrome exits, the bridge closes and removes its socket and exits. Chrome exits when its command pipe reaches end of file, measured at under half a second on Chrome 156, so a bridge killed outright takes its browser with it. On SIGTERM the bridge sends SIGTERM to Chrome and waits for it, and only after a grace period kills that one child, which is still unreaped and so cannot be another process.

**Startup records the bridge.** The launch barrier is unchanged: the waiting child still waits for `GO` on the anonymous pipe and then execs, now into the bridge, so the recorded PID and start ticks are the bridge's. A recorded process is ours only if its start ticks match and its command line carries the exact profile, `--remote-debugging-pipe`, `--cdp-bridge` and the socket path. Every listening Unix socket bound to exactly that path, read from `/proc/net/unix`, must be a descriptor of that process; anything else fails closed with "The browser debugger socket is not owned by this desktop." Readiness is one `Browser.getVersion` round trip through the socket. Stopping the browser for a port change signals the bridge and waits for its start ticks to change, which now also means the browser has exited and the profile is free.

**Observation goes through a browser-level session.** `Target.getTargets`, the same web-content filter as before, `Target.attachToTarget` with `flatten`, the same fixed read-only DOM and console calls on that session, then the connection closes and the bridge detaches the session. Replies count only from the session that was asked, events only from that session.

## Consequences

- Nothing in the desktop listens on a debugging port, so a forwarded listener on any TCP port no longer concerns startup. `desktop-start.test.ts` starts the desktop beside a foreign listener on 9222. The previous script, given a listener that appears beside its browser's as on E2B, fails with the exact line the diagnostic recorded ([reproduction](../research/desktop-startup/README.md#private-debugger)).
- The debugger's access boundary is the desktop's Unix user and root. That is not a sandbox against the agent: the agent's commands run as the same user and could already reach the loopback port before. It is a boundary against the network, which is the one that was in doubt.
- The desktop runs one more long-lived Node process.
- Request bookkeeping is bounded, including orphan attaches and unanswered cleanup. Saturation refuses new commands while accepted replies and owned-session events continue to route; disconnect releases ordinary requests without retaining dead clients.
- A sandbox still running a browser from the old script has an ownership record whose process carries no bridge arguments. Startup refuses to signal it, as it refuses any identity mismatch; such a sandbox needs replacing, as the previous migration did.
- Readiness used to ask an HTTP endpoint with curl. It now runs the driver, so the readiness check and the observations share one client implementation.

## Alternatives rejected

- **Ignore the foreign listener.** Accepting a listener that no desktop process holds would start the desktop while DevTools may be public, which is the outcome the ownership check exists to prevent. Public exposure was not measured.
- **Set `allowPublicTraffic: false`.** Every sandbox host would then require E2B's traffic token, including the preview and the stream the owner's browser loads directly, which changes how the whole product reaches a sandbox to fix one port. And a forwarded DevTools would still be one leaked token away from full control.
- **Firewall the port in the template.** It puts a root-owned rule set in the image that nothing in this repository checks, against a suspected forwarder whose precise mechanism was not measured. A rule could also block the desktop's own clients. Safety would rest on state no test can see.
- **Move the debugger to a different TCP port.** Changing the number would still leave a TCP debugging listener whose forwarding and public reachability were unmeasured.
