# Right-panel review evidence

Captured 2026-10-23 with actual Nap components and local fixture data.

- Candidate: `027eb0effe22ea02f86f6681fa4f3f6419720e18`, tree `eab007cdb722b947e353d81e7f64ed7fa993ede0`.
- Verified merge checkpoint: `3d6fcd027db84b79f932e85439b1a13895141749`, identical tree.
- Base: `1d474b48b65a0739bf573302d9ba8403dcd3042a`.
- macOS 27.0.1 arm64, Chrome 153.0.8010.54, Node 26.12.0, Next 16.3.0, scale 1.
- Desktop images: 1440×900. Mobile images use the viewport in their filename, without touch or OS keyboard emulation.

V016 passed 21/21 candidate groups and both base captures. Coverage includes retained iframe input, loaded highlighted files/diffs, raw fallback, PR refresh/stale-response recovery, Retry/Clear focus, tab persistence/closure/reopening, native pointer drops in both directions, keyboard ordering and resize, and 981/980/390px responsive states. There were no browser console or page errors. A postflight probe initially mistook TIME_WAIT for an active listener; its corrected bounded check passed. No product/browser rerun was needed.

`interactions.mp4` is a time-compressed sequence of ten screenshots of real interactions, not continuous screen recording. It has ten H.264 frames at 720×450, 2 fps, five seconds, no audio. It shows retained input, maximize, ordering results, close and reopen. It does not show pointer trajectories or every assertion. Both native drops were independently asserted through trusted browser events. Every decoded frame was inspected.

V015 on the candidate passed 4,976 tests in 372 files, typecheck, lint and production build. The focused fallback/PR group passed 44 tests after six expected failures and 38 controls on the tests-only snapshot. The prior UI group passed 28 tests. Bun 1.4.2 was used; the repository declares 1.3.13. Existing nonfatal lint diagnostics remain.

These fixtures do not prove live GitHub access/rate limits, OS clipboard, cross-origin focus, mobile touch/keyboard, or actual Stop cancellation. Browser remains an iframe, not a shared-agent browser. Git consistency is best effort. Raw fallback recognizes the covered unsupported hunk formats, not every arbitrary corruption.

The SHA-256 inventory records the original media bytes. Publication does not relabel the captures as a later application revision.
