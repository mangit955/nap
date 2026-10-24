# Actual noVNC client and server evidence

The local probe uses Nap's installed noVNC 1.5.0 client against the actual Docker x11vnc and websockify servers. It uses a separate temporary-profile Google Chrome through the existing installed Playwright Core. It never connects to a user browser or Devin CDP.

Run from the repository root with the repaired production source available:

```bash
NAP_CHROME_SOURCE_ROOT=/Users/manasraghuwanshi/.t3/worktrees/nap/feat-computer-use \
  NAP_CHROME_EXPECTED_DRIVER_SHA256=a37b17e66de0576068bdcc44eed9b3a0b47a5f42ed7239287c9e7e3a89cd7a11 \
  node docs/research/computer-chrome-linux/check-vnc.mjs /tmp/nap-vnc-evidence
```

Use a new or empty output directory. The checker first runs the complete desktop/policy/recording smoke, then holds its owned container for at most 90 additional seconds within the existing four-minute runtime deadline. The host binds one loopback HTTP and WebSocket listener to an ephemeral port. A byte-preserving `docker exec -i` TCP pipe reaches container-local websockify on 6080. Docker remains network-none, without host port publication. Ports 3037, 3038, and 3039 are untouched. Temporary browser profiles, bridge processes, listeners, container and image tags belong to this run only.

The generated password passes from the production credentials operation to the browser in memory. The checker does not print it, write it, trace browser protocol messages, or capture an authentication form. A wrong password must cause noVNC's security-failure event without connection. The correct password must authenticate and yield a 1024×768 canvas with more than eight sampled colors. The real decoded canvas is saved as PNG.

The first client has `viewOnly=true`, matching the production client's setting. A separate adversarial client explicitly has `viewOnly=false`. This dedicated harness uses noVNC 1.5's RFB message writer to send an X key down/up and an Apply-button pointer down/up. Instrumentation after authentication counts the actual outgoing key and pointer messages, without retaining their byte payloads. The real server must ignore the pointer. A physical Apply click must then show that the key did not alter the field either. Production physical input subsequently writes `PHYSICAL-AFTER-VNC`, and the changed framebuffer is decoded again.

The writable-server control removes only `-viewonly` from the owned temporary startup copy:

```bash
NAP_CHROME_SOURCE_ROOT=/Users/manasraghuwanshi/.t3/worktrees/nap/feat-computer-use \
  NAP_CHROME_EXPECTED_DRIVER_SHA256=a37b17e66de0576068bdcc44eed9b3a0b47a5f42ed7239287c9e7e3a89cd7a11 \
  node docs/research/computer-chrome-linux/check-vnc.mjs /tmp/nap-vnc-writable-control writable
```

It must exit nonzero. The control produced `Applied: BASEx` after the same two key and two pointer messages. That demonstrates a valid input attempt rather than relying on a client-side view-only setting. No production source or manifest changes for this control. A subsequent normal probe must pass again.

The retained reports distinguish the installed client version, host Chrome version, desktop Chrome provenance, sampled pixels, decoded image hashes, adversarial message counts, server refusal, subsequent physical input, and verified resource cleanup. The initial decoded frame establishes framebuffer delivery, not first-frame freshness. The later PNG shows the current fixture and physical marker. This probe does not establish frame-to-runtime timing, E2B proxy behavior, owner authentication, queue exclusion, or the complete React ComputerPane flow.

`verified/vnc-report.json` records the final passing run in 92.721 seconds, using host Chrome 153.0.8010.54 and container Chrome 156.0.8078.47. It decoded a 1024×768 PNG with 354 sampled colors and 141,330 bytes. `verified/vnc-after-physical.png` visibly contains the physical marker. The production-style client actually reported `viewOnly=true`; the separate adversarial client reported false and sent exactly two key and two pointer messages. The server ignored both. The exact prepared driver hash matched, and the real core recording passed strict decoding before the VNC phase.

`writable-control/vnc-report.json` records the intended failure in 93.717 seconds. The same messages produced `Applied: BASEx`, also visible in `writable-control/vnc-adversarial.png`. Both this control and the restored passing probe verified owned Docker cleanup. The final passing probe also confirms that its HTTP listener closed and temporary browser profile was removed. Earlier probe reports, including the first writable control's runner export error after forced container removal, remain under `earlier-probes/`.

The core report still records the 1-GiB cgroup ceiling, max events and OOM counters. Authentication and decoding do not establish memory headroom.
